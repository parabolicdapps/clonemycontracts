//! cmc-runner: execute an Anchor program (and SPL token programs) in an in-process litesvm runtime,
//! driven by a JSON plan. See toolchains/solana/RUNNER.md for the protocol.
mod idl;
mod live;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use idl::{get_ci, norm, Env, R};
use litesvm::types::TransactionResult;
use litesvm::LiteSVM;
use solana_hash::Hash;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::str::FromStr;

const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");
const TOKEN: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RENT: Address = Address::from_str_const("SysvarRent111111111111111111111111111111111");
const CLOCK: Address = Address::from_str_const("SysvarC1ock11111111111111111111111111111111");

const TOKEN_ERRORS: [&str; 20] = [
    "NotRentExempt", "InsufficientFunds", "InvalidMint", "MintMismatch", "OwnerMismatch", "FixedSupply",
    "AlreadyInUse", "InvalidNumberOfProvidedSigners", "InvalidNumberOfRequiredSigners", "UninitializedState",
    "NativeNotSupported", "NonNativeHasBalance", "InvalidInstruction", "InvalidState", "Overflow",
    "AuthorityTypeNotSupported", "MintCannotFreeze", "AccountFrozen", "MintDecimalsMismatch", "NonNativeNotSupported",
];
const TOKEN_ERROR_MSGS: [&str; 20] = [
    "Lamport balance below rent-exempt threshold", "Insufficient funds", "Invalid Mint", "Account not associated with this Mint",
    "Owner does not match", "Fixed supply", "Already in use", "Invalid number of provided signers",
    "Invalid number of required signers", "State is uninitialized", "Instruction does not support native tokens",
    "Non-native account can only be closed if its balance is zero", "Invalid instruction", "State is invalid for requested operation",
    "Operation overflowed", "Account does not support specified authority type", "This token mint cannot freeze accounts",
    "Account is frozen", "The provided decimals value different from the Mint decimals", "Instruction does not support non-native tokens",
];

fn seed_of(prefix: &str, name: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(prefix.as_bytes());
    h.update(name.as_bytes());
    h.finalize().into()
}

fn kp_from_seed(s: &[u8; 32]) -> Keypair {
    Keypair::new_from_array(*s)
}

enum Backend {
    Sim(LiteSVM),
    Live(live::Rpc),
}

/// Backend-neutral transaction outcome.
struct TxRes {
    error: Option<String>,
    code: Option<u32>,
    logs: Vec<String>,
    units: u64,
    ret: Option<(String, Vec<u8>)>,
}

impl TxRes {
    fn from_sim(r: TransactionResult) -> TxRes {
        let conv = |e: &TransactionError| -> (String, Option<u32>) {
            let code = match e {
                TransactionError::InstructionError(_, solana_instruction_error::InstructionError::Custom(c)) => Some(*c),
                _ => None,
            };
            (e.to_string(), code)
        };
        match r {
            Ok(m) => TxRes { error: None, code: None, logs: m.logs, units: m.compute_units_consumed, ret: (!m.return_data.data.is_empty()).then(|| (m.return_data.program_id.to_string(), m.return_data.data)) },
            Err(f) => {
                let (error, code) = conv(&f.err);
                TxRes { error: Some(error), code, logs: f.meta.logs, units: f.meta.compute_units_consumed, ret: None }
            }
        }
    }
    fn failed(msg: String) -> TxRes {
        TxRes { error: Some(msg), code: None, logs: vec![], units: 0, ret: None }
    }
}

struct Scenario {
    be: Backend,
    seeds: HashMap<Address, [u8; 32]>,
    actors: HashMap<String, Address>,
    names: HashMap<String, Address>,
    rev: HashMap<Address, String>,
    program: Option<Address>,
    idl: Option<Rc<Value>>,
}

fn s_of<'a>(v: &'a Value, k: &str) -> R<&'a str> {
    v.get(k).and_then(|x| x.as_str()).ok_or_else(|| format!("missing string field '{k}'"))
}

impl Scenario {
    fn get_account(&self, a: &Address) -> Option<live::Acct> {
        match &self.be {
            Backend::Sim(s) => s.get_account(a).map(|x| live::Acct { lamports: x.lamports, data: x.data.clone(), owner: x.owner, executable: x.executable }),
            Backend::Live(r) => r.get_account(a).ok().flatten(),
        }
    }

    fn is_live(&self) -> bool {
        matches!(self.be, Backend::Live(_))
    }

    fn rent_min(&self, len: usize) -> u64 {
        match &self.be {
            Backend::Sim(s) => s.minimum_balance_for_rent_exemption(len),
            Backend::Live(_) => (len as u64 + 128) * 6960,
        }
    }

    fn do_airdrop(&mut self, to: &Address, lamports: u64) -> TxRes {
        match &mut self.be {
            Backend::Sim(s) => TxRes::from_sim(s.airdrop(to, lamports)),
            Backend::Live(r) => match r.request_airdrop(to, lamports).and_then(|sig| r.confirm(&sig)) {
                Ok(()) => TxRes { error: None, code: None, logs: vec![], units: 0, ret: None },
                Err(e) => TxRes::failed(e),
            },
        }
    }

    fn show(&self, a: &Address) -> String {
        self.rev.get(a).cloned().unwrap_or_else(|| a.to_string())
    }

    fn env_run<T>(&self, subst: bool, f: impl FnOnce(&Env) -> T) -> T {
        let resolve = |v: &Value| -> R<[u8; 32]> { self.resolve_ref(v).map(|a| a.to_bytes()) };
        let show = |k: &[u8; 32]| -> String { self.show(&Address::new_from_array(*k)) };
        let env = Env { resolve: &resolve, show: &show, subst };
        f(&env)
    }

    fn add_keypair(&mut self, seed: [u8; 32]) -> Address {
        let a = kp_from_seed(&seed).pubkey();
        self.seeds.insert(a, seed);
        a
    }

    fn resolve_ref(&self, v: &Value) -> R<Address> {
        match v {
            Value::String(s) => {
                if let Some(n) = s.strip_prefix("actor:") {
                    return self.actors.get(n).copied().ok_or_else(|| format!("unknown actor '{n}'"));
                }
                if let Some(n) = s.strip_prefix("name:") {
                    return self.names.get(n).copied().ok_or_else(|| format!("unknown name '{n}'"));
                }
                Ok(match s.as_str() {
                    "program" => return self.program.ok_or_else(|| "no program loaded".to_string()),
                    "system" => SYSTEM,
                    "token_program" => TOKEN,
                    "token_2022_program" => TOKEN_2022,
                    "ata_program" => ATA_PROGRAM,
                    "rent" => RENT,
                    "clock" => CLOCK,
                    other => Address::from_str(other).map_err(|_| format!("bad pubkey / unknown ref '{other}'"))?,
                })
            }
            Value::Object(o) => {
                if let Some(a) = o.get("ata") {
                    let owner = self.resolve_ref(a.get("owner").ok_or("ata: missing owner")?)?;
                    let mint = self.resolve_ref(a.get("mint").ok_or("ata: missing mint")?)?;
                    let tp = match a.get("token_program") {
                        Some(t) if !t.is_null() => self.resolve_ref(t)?,
                        _ => TOKEN,
                    };
                    Ok(Address::find_program_address(&[owner.as_ref(), tp.as_ref(), mint.as_ref()], &ATA_PROGRAM).0)
                } else if let Some(f) = o.get("field") {
                    self.resolve_field(f)
                } else if let Some(p) = o.get("pda") {
                    let prog = match p.get("program") {
                        Some(x) if !x.is_null() => self.resolve_ref(x)?,
                        _ => self.program.ok_or("pda: no program loaded")?,
                    };
                    let mut seeds: Vec<Vec<u8>> = Vec::new();
                    for s in p.get("seeds").and_then(|s| s.as_array()).ok_or("pda: missing seeds")? {
                        seeds.push(self.plan_seed(s)?);
                    }
                    let refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
                    Ok(Address::find_program_address(&refs, &prog).0)
                } else {
                    Err(format!("bad ref object {v}"))
                }
            }
            _ => Err(format!("bad ref {v}")),
        }
    }

    /// {"field":{"account":Ref,"type":"Config","path":"a.b.0"}}: read a pubkey out of account state right now.
    fn resolve_field(&self, f: &Value) -> R<Address> {
        let addr = self.resolve_ref(f.get("account").ok_or("field: missing 'account'")?)?;
        let ty = s_of(f, "type").map_err(|e| format!("field: {e}"))?;
        let path = s_of(f, "path").map_err(|e| format!("field: {e}"))?;
        let idl = self.idl.clone().ok_or("field: no IDL loaded")?;
        let acc = self.get_account(&addr).ok_or_else(|| format!("field: account {} does not exist", self.show(&addr)))?;
        let ent = idl.get("accounts").and_then(|a| a.as_array()).and_then(|a| a.iter().find(|x| x["name"] == ty)).ok_or_else(|| format!("field: account type '{ty}' not in IDL"))?;
        let disc: Vec<u8> = ent["discriminator"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64()).map(|x| x as u8).collect()).unwrap_or_default();
        if acc.data.len() < disc.len() || acc.data[..disc.len()] != disc[..] {
            return Err(format!("field: discriminator mismatch, account is not a {ty}"));
        }
        let val = self.env_run(false, |env| idl::decode_named(&idl, ty, &acc.data[disc.len()..], env))?;
        let parts: Vec<&str> = path.split('.').collect();
        let v = idl::navigate(&val, &parts).ok_or_else(|| format!("field: no path '{path}' in {ty}"))?;
        let s = v.as_str().ok_or_else(|| format!("field: '{path}' is not a pubkey"))?;
        Address::from_str(s).map_err(|_| format!("field: '{path}' is not a pubkey"))
    }

    fn plan_seed(&self, s: &Value) -> R<Vec<u8>> {
        let o = s.as_object().ok_or("seed must be an object")?;
        if let Some(x) = o.get("str") {
            return Ok(x.as_str().ok_or("str seed must be a string")?.as_bytes().to_vec());
        }
        if let Some(x) = o.get("hex") {
            return idl::hex_decode(x.as_str().ok_or("hex seed must be a string")?);
        }
        if let Some(x) = o.get("ref") {
            return Ok(self.resolve_ref(x)?.to_bytes().to_vec());
        }
        for t in ["u8", "u16", "u32", "u64", "u128"] {
            if let Some(x) = o.get(t) {
                return idl::int_bytes(t, x);
            }
        }
        Err(format!("unsupported seed {s}"))
    }

    fn keypair(&self, a: &Address) -> Option<Keypair> {
        self.seeds.get(a).map(kp_from_seed)
    }

    fn sign_and_send(&mut self, ixs: Vec<Instruction>, payer: &Address, allowed: &[Address]) -> R<TxRes> {
        let msg = Message::new(&ixs, Some(payer));
        let nreq = msg.header.num_required_signatures as usize;
        let need: Vec<Address> = msg.account_keys[..nreq].to_vec();
        let bh = match &mut self.be {
            Backend::Sim(s) => {
                s.expire_blockhash();
                s.latest_blockhash()
            }
            Backend::Live(r) => Hash::new_from_array(r.latest_blockhash()?.to_bytes()),
        };
        let mut tx = Transaction::new_unsigned(msg);
        tx.message.recent_blockhash = bh;
        let data = tx.message_data();
        tx.signatures = vec![Signature::default(); nreq];
        for (i, k) in need.iter().enumerate() {
            if k == payer || allowed.contains(k) {
                if let Some(kp) = self.keypair(k) {
                    tx.signatures[i] = kp.sign_message(&data);
                }
            }
        }
        Ok(match &mut self.be {
            Backend::Sim(s) => TxRes::from_sim(s.send_transaction(tx)),
            Backend::Live(r) => {
                let mut wire = vec![nreq as u8];
                for sg in &tx.signatures {
                    wire.extend(<[u8; 64]>::from(*sg));
                }
                wire.extend(&data);
                match r.send_raw(&wire).and_then(|sig| r.confirm(&sig).and_then(|_| r.get_tx(&sig))) {
                    Err(e) => TxRes::failed(e),
                    Ok(t) => {
                        let meta = &t["meta"];
                        let logs: Vec<String> = meta["logMessages"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
                        let (error, code) = if meta["err"].is_null() { (None, None) } else { let (e, c) = live::fmt_tx_err(&meta["err"]); (Some(e), c) };
                        let ret = meta["returnData"]["data"][0].as_str().and_then(|b| B64.decode(b).ok()).filter(|d| !d.is_empty()).map(|d| (meta["returnData"]["programId"].as_str().unwrap_or("").to_string(), d));
                        TxRes { error, code, logs, units: meta["computeUnitsConsumed"].as_u64().unwrap_or(0), ret }
                    }
                }
            }
        })
    }

    /// Turn a transaction result into the common result fields.
    fn tx_fields(&self, r: &mut Map<String, Value>, res: TxRes) {
        let TxRes { error: err, code: ccode, logs, units, ret } = res;
        r.insert("ok".into(), json!(err.is_none()));
        let (mut code, mut ename, mut emsg) = (Value::Null, Value::Null, Value::Null);
        let estr = err.clone().map(Value::String).unwrap_or(Value::Null);
        if let Some(c) = ccode {
            code = json!(c);
            let (n, mm) = self.decode_error(c, &logs);
            ename = n.map(Value::String).unwrap_or(Value::Null);
            emsg = mm.map(Value::String).unwrap_or(Value::Null);
        }
        r.insert("error".into(), estr);
        r.insert("error_code".into(), code);
        r.insert("error_name".into(), ename);
        r.insert("error_message".into(), emsg);
        let events = if err.is_none() { self.decode_events(&logs) } else { vec![] };
        r.insert("events".into(), Value::Array(events));
        r.insert("units".into(), json!(units));
        let rd = match &ret {
            Some((p, d)) => json!({"program": p, "base64": B64.encode(d)}),
            None => Value::Null,
        };
        r.insert("return_data".into(), rd);
        r.insert("logs".into(), json!(logs));
    }

    fn decode_error(&self, code: u32, logs: &[String]) -> (Option<String>, Option<String>) {
        // first failing program in the log (innermost) is the origin of the error
        let origin = logs.iter().find_map(|l| {
            let rest = l.strip_prefix("Program ")?;
            let (pid, tail) = rest.split_once(' ')?;
            tail.starts_with("failed:").then(|| pid.to_string())
        });
        let anchor_line = logs.iter().find_map(|l| {
            let i = l.find("Error Code: ")?;
            let s = &l[i + 12..];
            let (name, s) = s.split_once(". Error Number: ")?;
            let (num, s) = s.split_once(". Error Message: ")?;
            (num.trim().parse::<u32>().ok()? == code).then(|| (name.to_string(), s.trim_end_matches('.').to_string()))
        });
        let app = self.program.map(|p| p.to_string());
        let from_idl = || {
            self.idl.as_ref().and_then(|i| i.get("errors")).and_then(|e| e.as_array()).and_then(|errs| {
                errs.iter().find(|e| e["code"].as_u64() == Some(code as u64)).map(|e| {
                    (e["name"].as_str().unwrap_or("").to_string(), e["msg"].as_str().map(|s| s.to_string()))
                })
            })
        };
        let is_token = matches!(origin.as_deref(), Some(p) if p == TOKEN.to_string() || p == TOKEN_2022.to_string());
        if is_token && (code as usize) < TOKEN_ERRORS.len() {
            return (Some(TOKEN_ERRORS[code as usize].into()), Some(TOKEN_ERROR_MSGS[code as usize].into()));
        }
        if origin.is_some() && origin == app {
            if let Some((n, m)) = from_idl() {
                return (Some(n), m);
            }
        }
        if let Some((n, m)) = anchor_line {
            return (Some(n), Some(m));
        }
        if origin.is_none() || origin == app {
            if let Some((n, m)) = from_idl() {
                return (Some(n), m);
            }
        }
        (None, None)
    }

    fn decode_events(&self, logs: &[String]) -> Vec<Value> {
        let Some(idl) = self.idl.clone() else { return vec![] };
        let Some(evs) = idl.get("events").and_then(|e| e.as_array()) else { return vec![] };
        let mut out = vec![];
        for l in logs {
            let Some(b64) = l.strip_prefix("Program data: ") else { continue };
            let Ok(bytes) = B64.decode(b64.trim()) else { continue };
            if bytes.len() < 8 {
                continue;
            }
            for e in evs {
                let disc: Vec<u8> = e["discriminator"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64()).map(|x| x as u8).collect()).unwrap_or_default();
                if disc == bytes[..8] {
                    let name = e["name"].as_str().unwrap_or("");
                    let data = self.env_run(true, |env| idl::decode_named(&idl, name, &bytes[8..], env));
                    match data {
                        Ok(d) => out.push(json!({"name": name, "data": d})),
                        Err(er) => out.push(json!({"name": name, "decode_error": er})),
                    }
                }
            }
        }
        out
    }

    // ---------------------------------------------------------------- steps
    fn run_step(&mut self, index: usize, step: &Value) -> Value {
        let op = step.get("op").and_then(|o| o.as_str()).unwrap_or("").to_string();
        let mut r = Map::new();
        r.insert("index".into(), json!(index));
        if let Some(id) = step.get("id") {
            r.insert("id".into(), id.clone());
        }
        r.insert("op".into(), json!(op));
        if let Err(e) = self.exec(&op, step, &mut r) {
            r.insert("runner_error".into(), json!(e));
            if !matches!(op.as_str(), "read_account" | "new_keypair" | "warp" | "advance") {
                r.insert("ok".into(), json!(false));
            }
        }
        Value::Object(r)
    }

    fn payer_of(&self, step: &Value, fallback: &Address) -> R<Address> {
        match step.get("payer") {
            Some(p) if !p.is_null() => self.resolve_ref(p),
            _ => Ok(*fallback),
        }
    }

    fn exec(&mut self, op: &str, step: &Value, r: &mut Map<String, Value>) -> R<()> {
        match op {
            "new_keypair" => {
                let name = s_of(step, "name")?.to_string();
                let a = self.add_keypair(seed_of("cmc-name:", &name));
                self.names.insert(name.clone(), a);
                self.rev.insert(a, format!("name:{name}"));
                r.insert("pubkey".into(), json!(a.to_string()));
            }
            "airdrop" => {
                let to = self.resolve_ref(step.get("to").ok_or("missing 'to'")?)?;
                let lamports = idl::parse_u64(step.get("lamports").ok_or("missing 'lamports'")?)?;
                let res = self.do_airdrop(&to, lamports);
                self.tx_fields(r, res);
            }
            "warp" | "advance" if self.is_live() => {
                r.insert("ok".into(), json!(true));
                r.insert("skipped".into(), json!("live validator"));
            }
            "warp" => {
                let ts = step.get("unix_timestamp").ok_or("missing 'unix_timestamp'")?;
                let ts: i64 = idl::int_bytes("i64", ts).map(|b| i64::from_le_bytes(b.try_into().unwrap()))?;
                self.set_time(|_| ts);
                r.insert("unix_timestamp".into(), json!(ts.to_string()));
            }
            "advance" => {
                let secs = step.get("seconds").ok_or("missing 'seconds'")?;
                let secs: i64 = idl::int_bytes("i64", secs).map(|b| i64::from_le_bytes(b.try_into().unwrap()))?;
                let ts = self.set_time(|cur| cur + secs);
                r.insert("unix_timestamp".into(), json!(ts.to_string()));
            }
            "spl_create_mint" => self.op_create_mint(step, r)?,
            "spl_create_ata" => {
                let owner = self.resolve_ref(step.get("owner").ok_or("missing 'owner'")?)?;
                let mint = self.resolve_ref(step.get("mint").ok_or("missing 'mint'")?)?;
                let payer = self.resolve_ref(step.get("payer").ok_or("missing 'payer'")?)?;
                let tp = match step.get("token_program") {
                    Some(t) if !t.is_null() => self.resolve_ref(t)?,
                    _ => TOKEN,
                };
                let ata = Address::find_program_address(&[owner.as_ref(), tp.as_ref(), mint.as_ref()], &ATA_PROGRAM).0;
                let ix = Instruction {
                    program_id: ATA_PROGRAM,
                    accounts: vec![
                        AccountMeta::new(payer, true),
                        AccountMeta::new(ata, false),
                        AccountMeta::new_readonly(owner, false),
                        AccountMeta::new_readonly(mint, false),
                        AccountMeta::new_readonly(SYSTEM, false),
                        AccountMeta::new_readonly(tp, false),
                    ],
                    data: vec![1],
                };
                let res = self.sign_and_send(vec![ix], &payer, &[payer])?;
                r.insert("address".into(), json!(ata.to_string()));
                self.tx_fields(r, res);
            }
            "spl_mint_to" => {
                let mint = self.resolve_ref(step.get("mint").ok_or("missing 'mint'")?)?;
                let to = self.resolve_ref(step.get("to").ok_or("missing 'to'")?)?;
                let amount = idl::parse_u64(step.get("amount").ok_or("missing 'amount'")?)?;
                let auth = self.resolve_ref(step.get("authority").ok_or("missing 'authority'")?)?;
                let mut data = vec![7];
                data.extend(amount.to_le_bytes());
                self.token_tx(step, r, vec![AccountMeta::new(mint, false), AccountMeta::new(to, false), AccountMeta::new_readonly(auth, true)], data, auth)?;
            }
            "spl_transfer" => {
                let from = self.resolve_ref(step.get("from").ok_or("missing 'from'")?)?;
                let to = self.resolve_ref(step.get("to").ok_or("missing 'to'")?)?;
                let amount = idl::parse_u64(step.get("amount").ok_or("missing 'amount'")?)?;
                let auth = self.resolve_ref(step.get("authority").ok_or("missing 'authority'")?)?;
                let mut data = vec![3];
                data.extend(amount.to_le_bytes());
                self.token_tx(step, r, vec![AccountMeta::new(from, false), AccountMeta::new(to, false), AccountMeta::new_readonly(auth, true)], data, auth)?;
            }
            "spl_approve" => {
                let acc = self.resolve_ref(step.get("account").ok_or("missing 'account'")?)?;
                let del = self.resolve_ref(step.get("delegate").ok_or("missing 'delegate'")?)?;
                let amount = idl::parse_u64(step.get("amount").ok_or("missing 'amount'")?)?;
                let owner = self.resolve_ref(step.get("owner").ok_or("missing 'owner'")?)?;
                let mut data = vec![4];
                data.extend(amount.to_le_bytes());
                self.token_tx(step, r, vec![AccountMeta::new(acc, false), AccountMeta::new_readonly(del, false), AccountMeta::new_readonly(owner, true)], data, owner)?;
            }
            "spl_revoke" => {
                let acc = self.resolve_ref(step.get("account").ok_or("missing 'account'")?)?;
                let owner = self.resolve_ref(step.get("owner").ok_or("missing 'owner'")?)?;
                self.token_tx(step, r, vec![AccountMeta::new(acc, false), AccountMeta::new_readonly(owner, true)], vec![5], owner)?;
            }
            "spl_burn" => {
                let acc = self.resolve_ref(step.get("account").ok_or("missing 'account'")?)?;
                let mint = self.resolve_ref(step.get("mint").ok_or("missing 'mint'")?)?;
                let amount = idl::parse_u64(step.get("amount").ok_or("missing 'amount'")?)?;
                let auth = self.resolve_ref(step.get("authority").ok_or("missing 'authority'")?)?;
                let mut data = vec![8];
                data.extend(amount.to_le_bytes());
                self.token_tx(step, r, vec![AccountMeta::new(acc, false), AccountMeta::new(mint, false), AccountMeta::new_readonly(auth, true)], data, auth)?;
            }
            "spl_set_authority" => {
                let target = self.resolve_ref(step.get("target").ok_or("missing 'target'")?)?;
                let cur = self.resolve_ref(step.get("current").ok_or("missing 'current'")?)?;
                let t = match s_of(step, "authority_type")? {
                    "mint" => 0u8,
                    "freeze" => 1,
                    "owner" => 2,
                    "close" => 3,
                    o => return Err(format!("bad authority_type '{o}'")),
                };
                let mut data = vec![6, t];
                match step.get("new") {
                    Some(n) if !n.is_null() => {
                        data.push(1);
                        data.extend(self.resolve_ref(n)?.to_bytes());
                    }
                    _ => data.push(0),
                }
                self.token_tx(step, r, vec![AccountMeta::new(target, false), AccountMeta::new_readonly(cur, true)], data, cur)?;
            }
            "ix" => self.op_ix(step, r)?,
            "read_account" => self.op_read(step, r)?,
            other => return Err(format!("unknown op '{other}'")),
        }
        Ok(())
    }

    /// Send a token-program instruction; the token program is detected from the (first) account's owner
    /// unless the step has "token_program".
    fn token_tx(&mut self, step: &Value, r: &mut Map<String, Value>, accounts: Vec<AccountMeta>, data: Vec<u8>, authority: Address) -> R<()> {
        let program_id = match step.get("token_program") {
            Some(t) if !t.is_null() => self.resolve_ref(t)?,
            _ => {
                let first = accounts[0].pubkey;
                match self.get_account(&first) {
                    Some(a) if a.owner == TOKEN_2022 => TOKEN_2022,
                    _ => TOKEN,
                }
            }
        };
        let payer = self.payer_of(step, &authority)?;
        let res = self.sign_and_send(vec![Instruction { program_id, accounts, data }], &payer, &[authority, payer])?;
        self.tx_fields(r, res);
        Ok(())
    }

    fn set_time(&mut self, f: impl FnOnce(i64) -> i64) -> i64 {
        let Backend::Sim(svm) = &mut self.be else { return 0 };
        let mut c: solana_clock::Clock = svm.get_sysvar();
        let new = f(c.unix_timestamp);
        let dt = new - c.unix_timestamp;
        c.slot += if dt > 0 { (dt as u64).saturating_mul(2).max(1) } else { 1 };
        c.unix_timestamp = new;
        svm.set_sysvar(&c);
        new
    }

    fn op_create_mint(&mut self, step: &Value, r: &mut Map<String, Value>) -> R<()> {
        let name = s_of(step, "name")?.to_string();
        let decimals = step.get("decimals").and_then(|d| d.as_u64()).filter(|d| *d < 256).ok_or("missing/bad 'decimals'")? as u8;
        let authority = self.resolve_ref(step.get("authority").ok_or("missing 'authority'")?)?;
        let freeze = match step.get("freeze") {
            Some(f) if !f.is_null() => Some(self.resolve_ref(f)?),
            _ => None,
        };
        let tp = match step.get("token_program") {
            Some(t) if !t.is_null() => self.resolve_ref(t)?,
            _ => TOKEN,
        };
        let payer = match step.get("payer") {
            Some(p) if !p.is_null() => self.resolve_ref(p)?,
            _ => *self.actors.values().min_by_key(|a| a.to_string()).ok_or("no payer and no actors")?,
        };
        let mint = self.add_keypair(seed_of("cmc-name:", &name));
        self.names.insert(name.clone(), mint);
        self.rev.insert(mint, format!("name:{name}"));
        let space = 82u64;
        let lamports = self.rent_min(space as usize);
        let mut cd = vec![0, 0, 0, 0];
        cd.extend(lamports.to_le_bytes());
        cd.extend(space.to_le_bytes());
        cd.extend(tp.to_bytes());
        let create = Instruction { program_id: SYSTEM, accounts: vec![AccountMeta::new(payer, true), AccountMeta::new(mint, true)], data: cd };
        let mut id = vec![20, decimals];
        id.extend(authority.to_bytes());
        match freeze {
            Some(f) => {
                id.push(1);
                id.extend(f.to_bytes());
            }
            None => id.push(0),
        }
        let init = Instruction { program_id: tp, accounts: vec![AccountMeta::new(mint, false)], data: id };
        let res = self.sign_and_send(vec![create, init], &payer, &[payer, mint])?;
        r.insert("address".into(), json!(mint.to_string()));
        self.tx_fields(r, res);
        Ok(())
    }

    fn op_read(&self, step: &Value, r: &mut Map<String, Value>) -> R<()> {
        let addr = self.resolve_ref(step.get("account").ok_or("missing 'account'")?)?;
        let ty = s_of(step, "type")?;
        if let Some(l) = step.get("as") {
            r.insert("as".into(), l.clone());
        }
        r.insert("address".into(), json!(addr.to_string()));
        let Some(acc) = self.get_account(&addr) else {
            r.insert("exists".into(), json!(false));
            return Ok(());
        };
        if acc.lamports == 0 && acc.data.is_empty() {
            r.insert("exists".into(), json!(false));
            return Ok(());
        }
        r.insert("exists".into(), json!(true));
        r.insert("lamports".into(), json!(acc.lamports.to_string()));
        r.insert("owner".into(), json!(self.show(&acc.owner)));
        r.insert("data_len".into(), json!(acc.data.len()));
        r.insert("executable".into(), json!(acc.executable));
        let d = &acc.data;
        let pk = |b: &[u8]| -> String { self.show(&Address::new_from_array(b.try_into().unwrap())) };
        let copt = |b: &[u8]| -> Value { if u32::from_le_bytes(b[..4].try_into().unwrap()) == 1 { json!(pk(&b[4..36])) } else { Value::Null } };
        let u64at = |o: usize| -> String { u64::from_le_bytes(d[o..o + 8].try_into().unwrap()).to_string() };
        let value = match ty {
            "lamports" => json!({"lamports": acc.lamports.to_string()}),
            "raw" => json!({"data_base64": B64.encode(d)}),
            "token" => {
                if d.len() < 165 {
                    return Err("account data too short for a token account".into());
                }
                let state = match d[108] { 0 => "uninitialized", 1 => "initialized", 2 => "frozen", _ => "unknown" };
                json!({
                    "mint": pk(&d[0..32]), "owner": pk(&d[32..64]), "amount": u64at(64),
                    "delegate": copt(&d[72..108]), "state": state,
                    "is_native": if u32::from_le_bytes(d[109..113].try_into().unwrap()) == 1 { json!(u64at(113)) } else { Value::Null },
                    "delegated_amount": u64at(121), "close_authority": copt(&d[129..165]),
                })
            }
            "mint" => {
                if d.len() < 82 {
                    return Err("account data too short for a mint".into());
                }
                json!({
                    "mint_authority": copt(&d[0..36]), "supply": u64at(36), "decimals": d[44],
                    "is_initialized": d[45] == 1, "freeze_authority": copt(&d[46..82]),
                })
            }
            name => {
                let idl = self.idl.clone().ok_or("no IDL loaded")?;
                let ent = idl.get("accounts").and_then(|a| a.as_array()).and_then(|a| a.iter().find(|x| x["name"] == name)).ok_or_else(|| format!("account type '{name}' not in IDL"))?;
                let disc: Vec<u8> = ent["discriminator"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64()).map(|x| x as u8).collect()).unwrap_or_default();
                if d.len() < disc.len() || d[..disc.len()] != disc[..] {
                    return Err(format!("discriminator mismatch: account is not a {name}"));
                }
                self.env_run(true, |env| idl::decode_named(&idl, name, &d[disc.len()..], env))?
            }
        };
        r.insert("value".into(), value);
        Ok(())
    }

    // ---------------------------------------------------------------- app instruction
    fn op_ix(&mut self, step: &Value, r: &mut Map<String, Value>) -> R<()> {
        let idl = self.idl.clone().ok_or("no program/IDL loaded for this plan")?;
        let program = self.program.ok_or("no program loaded")?;
        let name = s_of(step, "name")?;
        let ixdef = idl["instructions"].as_array().and_then(|a| a.iter().find(|i| norm(i["name"].as_str().unwrap_or("")) == norm(name))).ok_or_else(|| format!("instruction '{name}' not in IDL"))?;
        let empty = Map::new();
        let args = step.get("args").and_then(|a| a.as_object()).unwrap_or(&empty);
        let given = step.get("accounts").and_then(|a| a.as_object()).unwrap_or(&empty);
        let mut signers = vec![];
        for s in step.get("signers").and_then(|s| s.as_array()).unwrap_or(&vec![]) {
            signers.push(self.resolve_ref(s)?);
        }
        let payer = match step.get("payer") {
            Some(p) if !p.is_null() => self.resolve_ref(p)?,
            _ => *signers.first().ok_or("no 'payer' and no 'signers'")?,
        };
        // data
        let mut data: Vec<u8> = ixdef["discriminator"].as_array().ok_or("IDL instruction has no discriminator")?.iter().filter_map(|x| x.as_u64()).map(|x| x as u8).collect();
        let argdefs: Vec<Value> = ixdef["args"].as_array().cloned().unwrap_or_default();
        for a in &argdefs {
            let an = a["name"].as_str().unwrap_or("");
            let v = match get_ci(args, an) {
                Some(v) => v.clone(),
                None if a["type"].get("option").is_some() => Value::Null,
                None => return Err(format!("missing arg '{an}'")),
            };
            self.env_run(false, |env| idl::encode(&idl, &a["type"], &v, env, &mut data)).map_err(|e| format!("arg '{an}': {e}"))?;
        }
        // accounts
        let mut flat = vec![];
        flatten(ixdef["accounts"].as_array().ok_or("IDL instruction has no accounts")?, "", &mut flat);
        let res = AccRes { sc: self, idl: &idl, flat: &flat, given, args, argdefs: &argdefs, memo: RefCell::new(HashMap::new()), program };
        let mut metas = vec![];
        for (path, _leaf, def) in &flat {
            let addr = match res.resolve(path, 0)? {
                Some(a) => a,
                None => {
                    r.insert("runner_error".into(), json!(format!("unresolved account {path}")));
                    r.insert("ok".into(), json!(false));
                    return Ok(());
                }
            };
            let is_ph = res.is_placeholder(path);
            metas.push(AccountMeta {
                pubkey: addr,
                is_signer: !is_ph && def["signer"].as_bool().unwrap_or(false),
                is_writable: !is_ph && def["writable"].as_bool().unwrap_or(false),
            });
        }
        let mut allowed = signers.clone();
        allowed.push(payer);
        let out = self.sign_and_send(vec![Instruction { program_id: program, accounts: metas, data }], &payer, &allowed)?;
        self.tx_fields(r, out);
        Ok(())
    }
}

type Flat<'a> = Vec<(String, String, &'a Value)>;

fn flatten<'a>(list: &'a [Value], prefix: &str, out: &mut Flat<'a>) {
    for a in list {
        let name = a["name"].as_str().unwrap_or("");
        if let Some(sub) = a.get("accounts").and_then(|s| s.as_array()) {
            flatten(sub, &format!("{prefix}{name}_"), out);
        } else {
            out.push((format!("{prefix}{name}"), name.to_string(), a));
        }
    }
}

struct AccRes<'a> {
    sc: &'a Scenario,
    idl: &'a Value,
    flat: &'a Flat<'a>,
    given: &'a Map<String, Value>,
    args: &'a Map<String, Value>,
    argdefs: &'a [Value],
    memo: RefCell<HashMap<String, Option<Address>>>,
    program: Address,
}

impl<'a> AccRes<'a> {
    fn find(&self, name: &str) -> Option<&'a (String, String, &'a Value)> {
        let n = norm(name);
        self.flat.iter().find(|(p, _, _)| norm(p) == n).or_else(|| self.flat.iter().find(|(_, l, _)| norm(l) == n))
    }

    fn is_placeholder(&self, path: &str) -> bool {
        let Some((p, l, _)) = self.find(path) else { return false };
        matches!(self.given.get(p.as_str()).or_else(|| get_ci(self.given, l)).or_else(|| get_ci(self.given, p)), Some(Value::Null))
    }

    fn env_run<T>(&self, f: impl FnOnce(&Env) -> T) -> T {
        self.sc.env_run(false, f)
    }

    fn resolve(&self, name: &str, depth: u32) -> R<Option<Address>> {
        if depth > 16 {
            return Err(format!("PDA seed recursion too deep at '{name}'"));
        }
        let Some((path, leaf, def)) = self.find(name) else { return Err(format!("seed refers to unknown account '{name}'")) };
        if let Some(m) = self.memo.borrow().get(path) {
            return Ok(*m);
        }
        let out = self.resolve_inner(path, leaf, def, depth)?;
        self.memo.borrow_mut().insert(path.clone(), out);
        Ok(out)
    }

    fn resolve_inner(&self, path: &str, leaf: &str, def: &Value, depth: u32) -> R<Option<Address>> {
        // (1) explicit
        if let Some(v) = self.given.get(path).or_else(|| get_ci(self.given, leaf)).or_else(|| get_ci(self.given, path)) {
            if v.is_null() {
                if def["optional"].as_bool().unwrap_or(false) {
                    return Ok(Some(self.program));
                }
                return Ok(None);
            }
            return self.sc.resolve_ref(v).map(Some).map_err(|e| format!("account '{path}': {e}"));
        }
        // (2) fixed address
        if let Some(a) = def.get("address").and_then(|a| a.as_str()) {
            return Address::from_str(a).map(Some).map_err(|_| format!("bad IDL address for '{path}'"));
        }
        // (3) pda
        if let Some(p) = def.get("pda") {
            let mut seeds: Vec<Vec<u8>> = vec![];
            for s in p["seeds"].as_array().ok_or("pda without seeds")? {
                match self.seed(s, depth)? {
                    Some(b) => seeds.push(b),
                    None => return Ok(None),
                }
            }
            let prog = match p.get("program") {
                None => self.program,
                Some(pr) => match pr["kind"].as_str() {
                    Some("const") => {
                        let b: Vec<u8> = pr["value"].as_array().ok_or("bad program seed")?.iter().filter_map(|x| x.as_u64()).map(|x| x as u8).collect();
                        Address::new_from_array(b.try_into().map_err(|_| "program const must be 32 bytes")?)
                    }
                    Some("account") => match self.resolve(pr["path"].as_str().unwrap_or(""), depth + 1)? {
                        Some(a) => a,
                        None => return Ok(None),
                    },
                    _ => return Err("unsupported pda program seed".into()),
                },
            };
            let refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
            return Ok(Some(Address::find_program_address(&refs, &prog).0));
        }
        Ok(None)
    }

    fn seed(&self, s: &Value, depth: u32) -> R<Option<Vec<u8>>> {
        match s["kind"].as_str() {
            Some("const") => Ok(Some(s["value"].as_array().ok_or("const seed without value")?.iter().filter_map(|x| x.as_u64()).map(|x| x as u8).collect())),
            Some("arg") => {
                let path = s["path"].as_str().ok_or("arg seed without path")?;
                let parts: Vec<&str> = path.split('.').collect();
                let Some(adef) = self.argdefs.iter().find(|a| norm(a["name"].as_str().unwrap_or("")) == norm(parts[0])) else {
                    return Err(format!("arg seed '{path}' is not an instruction arg"));
                };
                let Some(v) = get_ci(self.args, parts[0]) else { return Err(format!("missing arg '{}' needed for a PDA seed", parts[0])) };
                let v = idl::navigate(v, &parts[1..]).ok_or_else(|| format!("no field path '{path}' in arg"))?;
                let ty = idl::field_type(self.idl, &adef["type"], &parts[1..])?;
                self.env_run(|env| idl::seed_bytes(self.idl, &ty, v, env)).map(Some)
            }
            Some("account") => {
                let path = s["path"].as_str().ok_or("account seed without path")?;
                let (acc, field) = match path.split_once('.') {
                    Some((a, f)) => (a, Some(f)),
                    None => (path, None),
                };
                let Some(addr) = self.resolve(acc, depth + 1)? else { return Ok(None) };
                let Some(field) = field else { return Ok(Some(addr.to_bytes().to_vec())) };
                let tname = s["account"].as_str().ok_or("account.field seed needs an 'account' type in the IDL")?;
                let a = self.sc.get_account(&addr).ok_or_else(|| format!("account '{acc}' ({addr}) does not exist; cannot read field '{field}' for a PDA seed"))?;
                let ent = self.idl["accounts"].as_array().and_then(|x| x.iter().find(|e| e["name"] == tname)).ok_or_else(|| format!("account type '{tname}' not in IDL"))?;
                let dl = ent["discriminator"].as_array().map(|d| d.len()).unwrap_or(8);
                let val = self.env_run(|env| idl::decode_named(self.idl, tname, &a.data[dl.min(a.data.len())..], env))?;
                let fparts: Vec<&str> = field.split('.').collect();
                let fv = idl::navigate(&val, &fparts).ok_or_else(|| format!("no field '{field}' in {tname}"))?;
                let ty = idl::field_type(self.idl, &json!({"defined": {"name": tname}}), &fparts)?;
                self.env_run(|env| idl::seed_bytes(self.idl, &ty, fv, env)).map(Some)
            }
            other => Err(format!("unsupported pda seed kind {other:?}")),
        }
    }
}

// -------------------------------------------------------------------- main
fn die(msg: &str) -> ! {
    eprintln!("cmc-runner: {msg}");
    std::process::exit(2)
}

fn num_field(plan: &Value, k: &str, default: u64) -> u64 {
    match plan.get(k) {
        Some(v) => idl::parse_u64(v).unwrap_or_else(|e| die(&format!("plan.{k}: {e}"))),
        None => default,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (mut plan_p, mut so_p, mut idl_p, mut rpc_url, mut prog_override, mut scen_id) = (None, None, None, None, None, None);
    let mut live_mode = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "live" if i == 0 => live_mode = true,
            "--plan" => { i += 1; plan_p = args.get(i).cloned() }
            "--so" => { i += 1; so_p = args.get(i).cloned() }
            "--idl" => { i += 1; idl_p = args.get(i).cloned() }
            "--rpc" => { i += 1; rpc_url = args.get(i).cloned() }
            "--program-id" => { i += 1; prog_override = args.get(i).cloned() }
            "--scenario" => { i += 1; scen_id = args.get(i).cloned() }
            "--version" => { println!("cmc-runner {}", env!("CARGO_PKG_VERSION")); return }
            o => die(&format!("unknown argument '{o}' (usage: cmc-runner --plan <plan.json> [--so <app.so> --idl <app.json>] | cmc-runner live --rpc <url> --plan <plan.json> --idl <app.json> [--so <app.so>] [--program-id <pubkey>] [--scenario <id>])")),
        }
        i += 1;
    }
    let plan_p = plan_p.unwrap_or_else(|| die("--plan is required"));
    let plan: Value = serde_json::from_slice(&std::fs::read(&plan_p).unwrap_or_else(|e| die(&format!("read {plan_p}: {e}")))).unwrap_or_else(|e| die(&format!("parse {plan_p}: {e}")));
    let read_idl = |d: &str| -> Rc<Value> { Rc::new(serde_json::from_slice(&std::fs::read(d).unwrap_or_else(|e| die(&format!("read {d}: {e}")))).unwrap_or_else(|e| die(&format!("parse {d}: {e}")))) };
    let (so, idl): (Option<Vec<u8>>, Option<Rc<Value>>) = if live_mode {
        // live: the program is deployed by the caller; the .so is not needed
        (None, idl_p.as_deref().map(read_idl))
    } else {
        match (so_p, idl_p) {
            (Some(s), Some(d)) => (Some(std::fs::read(&s).unwrap_or_else(|e| die(&format!("read {s}: {e}")))), Some(read_idl(&d))),
            (None, None) => (None, None),
            _ => die("--so and --idl must be given together"),
        }
    };
    let program = match (&prog_override, idl.as_ref()) {
        (Some(p), _) if live_mode => Some(Address::from_str(p).unwrap_or_else(|_| die("--program-id is not a pubkey"))),
        (_, Some(i)) => Some(Address::from_str(i["address"].as_str().unwrap_or_else(|| die("IDL has no 'address'"))).unwrap_or_else(|_| die("IDL 'address' is not a pubkey"))),
        _ => None,
    };
    let rpc = if live_mode { Some(rpc_url.clone().unwrap_or_else(|| "http://127.0.0.1:8899".into())) } else { None };
    if plan.get("version").and_then(|v| v.as_u64()) != Some(1) {
        die("plan.version must be 1");
    }
    let clock_start = match plan.get("clock_start") {
        Some(v) => idl::int_bytes("i64", v).map(|b| i64::from_le_bytes(b.try_into().unwrap())).unwrap_or_else(|e| die(&format!("plan.clock_start: {e}"))),
        None => 1_700_000_000,
    };
    let actor_lamports = num_field(&plan, "actor_lamports", 100_000_000_000);
    let actor_names: Vec<String> = plan.get("actors").and_then(|a| a.as_array()).map(|a| a.iter().map(|x| x.as_str().unwrap_or_else(|| die("plan.actors must be strings")).to_string()).collect()).unwrap_or_default();
    let scenarios = plan.get("scenarios").and_then(|s| s.as_array()).unwrap_or_else(|| die("plan.scenarios must be an array"));

    let mut out_scen = vec![];
    for (si, sc) in scenarios.iter().enumerate() {
        let id = sc.get("id").cloned().unwrap_or_else(|| json!(format!("s{si}")));
        if live_mode {
            let want = match &scen_id { Some(w) => id.as_str() == Some(w.as_str()), None => si == 0 };
            if !want {
                continue;
            }
        }
        let be = match &rpc {
            Some(u) => Backend::Live(live::Rpc::new(u).unwrap_or_else(|e| die(&e))),
            None => Backend::Sim(LiteSVM::new()),
        };
        let mut s = Scenario { be, seeds: HashMap::new(), actors: HashMap::new(), names: HashMap::new(), rev: HashMap::new(), program, idl: idl.clone() };
        let mut fatal: Option<String> = None;
        if let Some(p) = program {
            s.rev.insert(p, "program".into());
        }
        if let (Some(p), Some(bytes), Backend::Sim(svm)) = (program, so.as_ref(), &mut s.be) {
            if let Err(e) = svm.add_program(p, bytes) {
                fatal = Some(format!("failed to load program: {e}"));
            }
        }
        if let (Some(p), true) = (program, s.is_live()) {
            if s.get_account(&p).map_or(true, |a| !a.executable) {
                fatal = Some(format!("program {p} is not deployed (or not executable) on the validator"));
            }
        }
        if fatal.is_none() {
            if let Backend::Sim(_) = s.be {
                s.set_time(|_| clock_start);
                let Backend::Sim(svm) = &mut s.be else { unreachable!() };
                let mut c: solana_clock::Clock = svm.get_sysvar();
                c.epoch_start_timestamp = clock_start;
                svm.set_sysvar(&c);
            }
            for n in &actor_names {
                let a = s.add_keypair(seed_of("cmc-actor:", n));
                s.actors.insert(n.clone(), a);
                s.rev.insert(a, format!("actor:{n}"));
                let res = s.do_airdrop(&a, actor_lamports);
                if let Some(e) = res.error {
                    fatal = Some(format!("airdrop to actor '{n}' failed: {e}"));
                    break;
                }
            }
        }
        let mut steps = vec![];
        if fatal.is_none() {
            for (i, st) in sc.get("steps").and_then(|s| s.as_array()).unwrap_or(&vec![]).iter().enumerate() {
                steps.push(s.run_step(i, st));
            }
        }
        out_scen.push(json!({"id": id, "fatal": fatal, "steps": steps}));
    }
    if live_mode && out_scen.is_empty() {
        die("live: no matching scenario in the plan");
    }
    let result = if live_mode {
        json!({"runner": format!("cmc-runner {}", env!("CARGO_PKG_VERSION")), "mode": "live", "rpc": rpc, "program_id": program.map(|p| p.to_string()), "litesvm": null, "scenarios": out_scen})
    } else {
        json!({"runner": format!("cmc-runner {}", env!("CARGO_PKG_VERSION")), "litesvm": "0.18.2", "scenarios": out_scen})
    };
    println!("{}", serde_json::to_string(&result).unwrap());
}
