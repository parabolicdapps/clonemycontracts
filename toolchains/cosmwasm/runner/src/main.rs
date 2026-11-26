//! cmc-cosmwasm-runner: offline, in-process scenario runner for CosmWasm contracts (cw-multi-test).
//! The contract crate (`app`) is linked natively; cw20-base and cw721-base are registered as built-in code ids.
use cosmwasm_std::{
    to_json_binary, Addr, BlockInfo, Coin, CosmosMsg, Empty, Timestamp, Uint128, WasmMsg,
};
use cw_multi_test::{
    App, AppBuilder, AppResponse, BankKeeper, BankSudo, Contract, ContractWrapper, Executor,
    MockApiBech32, SudoMsg,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

const RUNNER: &str = "cmc-cosmwasm-runner 0.1.0";
const CW_MULTI_TEST: &str = "2.5.1";

type Chain = App<BankKeeper, MockApiBech32>;

fn code_app() -> Box<dyn Contract<Empty>> {
    Box::new(ContractWrapper::new(
        app::contract::execute,
        app::contract::instantiate,
        app::contract::query,
    ))
}
fn code_cw20() -> Box<dyn Contract<Empty>> {
    Box::new(ContractWrapper::new(
        cw20_base::contract::execute,
        cw20_base::contract::instantiate,
        cw20_base::contract::query,
    ))
}
fn code_cw721() -> Box<dyn Contract<Empty>> {
    Box::new(ContractWrapper::new(
        cw721_base::entry::execute,
        cw721_base::entry::instantiate,
        cw721_base::entry::query,
    ))
}

struct Ctx {
    app: Chain,
    codes: BTreeMap<&'static str, u64>,
    /// "actor:alice" / "name:tok" / "app" -> address
    addrs: BTreeMap<String, String>,
    actors: Vec<String>,
}

type R<T> = Result<T, String>;

impl Ctx {
    /// None = not ref-shaped. Some(Err) = ref-shaped but unresolvable.
    fn lookup(&self, s: &str) -> Option<R<String>> {
        if s.starts_with("actor:") || s.starts_with("name:") {
            return Some(
                self.addrs
                    .get(s)
                    .cloned()
                    .ok_or_else(|| format!("unresolved ref '{s}'")),
            );
        }
        if s == "app" {
            return self.addrs.get("app").cloned().map(Ok);
        }
        None
    }
    /// A Ref position: refs are resolved, any other string is taken as a literal address.
    fn reference(&self, v: Option<&Value>, what: &str) -> R<String> {
        let s = v
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("missing or non-string '{what}'"))?;
        match self.lookup(s) {
            Some(r) => r,
            None if s == "app" => Err("unresolved ref 'app' (the app contract is not instantiated)".into()),
            None => Ok(s.to_string()),
        }
    }
    /// Replace exact-match ref strings anywhere inside a JSON value.
    fn walk(&self, v: &Value) -> R<Value> {
        Ok(match v {
            Value::String(s) => match self.lookup(s) {
                Some(r) => Value::String(r?),
                None => v.clone(),
            },
            Value::Array(a) => Value::Array(a.iter().map(|x| self.walk(x)).collect::<R<Vec<_>>>()?),
            Value::Object(o) => {
                let mut m = Map::new();
                for (k, x) in o {
                    m.insert(k.clone(), self.walk(x)?);
                }
                Value::Object(m)
            }
            _ => v.clone(),
        })
    }
    fn msg(&self, step: &Value) -> R<Value> {
        self.walk(step.get("msg").ok_or("missing 'msg'")?)
    }
    fn funds(&self, step: &Value) -> R<Vec<Coin>> {
        match step.get("funds") {
            None | Some(Value::Null) => Ok(vec![]),
            Some(v) => parse_coins(v),
        }
    }
}

fn parse_coins(v: &Value) -> R<Vec<Coin>> {
    let arr = v.as_array().ok_or("'funds' must be an array")?;
    arr.iter()
        .map(|c| {
            let denom = c.get("denom").and_then(|d| d.as_str()).ok_or("coin without denom")?;
            let amount = c.get("amount").and_then(|d| d.as_str()).ok_or("coin amount must be a string")?;
            let amount: Uint128 = amount.parse().map_err(|e| format!("bad amount '{amount}': {e}"))?;
            Ok(Coin::new(amount, denom))
        })
        .collect()
}

fn attrs(r: &AppResponse) -> Value {
    let mut out = vec![];
    for e in &r.events {
        for a in &e.attributes {
            out.push(json!({"ty": e.ty, "key": a.key, "value": a.value}));
        }
    }
    Value::Array(out)
}

fn fail(res: &mut Map<String, Value>, err: &anyhow::Error) {
    res.insert("ok".into(), json!(false));
    res.insert("error".into(), json!(err.root_cause().to_string()));
    let chain = format!("{err:#}");
    if chain != err.root_cause().to_string() {
        res.insert("error_chain".into(), json!(chain));
    }
}

fn runner_error(res: &mut Map<String, Value>, msg: String) {
    res.insert("ok".into(), json!(false));
    res.insert("runner_error".into(), json!(msg));
}

fn step(cx: &mut Ctx, index: usize, st: &Value) -> Map<String, Value> {
    let op = st.get("op").and_then(|o| o.as_str()).unwrap_or("").to_string();
    let mut res = Map::new();
    res.insert("index".into(), json!(index));
    res.insert("op".into(), json!(op));
    res.insert("id".into(), st.get("id").cloned().unwrap_or(Value::Null));
    res.insert("ok".into(), json!(true));
    res.insert("error".into(), Value::Null);
    res.insert("runner_error".into(), Value::Null);
    let out = catch_unwind(AssertUnwindSafe(|| run_op(cx, &op, st, &mut res)));
    match out {
        Ok(Ok(())) => {}
        Ok(Err(e)) => runner_error(&mut res, e),
        Err(p) => {
            let m = p
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| p.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".into());
            res.insert("ok".into(), json!(false));
            res.insert("error".into(), json!(format!("panic: {m}")));
        }
    }
    res
}

fn run_op(cx: &mut Ctx, op: &str, st: &Value, res: &mut Map<String, Value>) -> R<()> {
    match op {
        "advance" => {}
        "warp" => {
            let t = st
                .get("unix_timestamp")
                .and_then(|t| t.as_u64().or_else(|| t.as_str().and_then(|s| s.parse().ok())))
                .ok_or("warp needs unix_timestamp")?;
            cx.app.update_block(|b| {
                b.time = Timestamp::from_seconds(t);
                b.height += 1;
            });
        }
        "fund" => {
            let to = cx.reference(st.get("to"), "to")?;
            let denom = st.get("denom").and_then(|d| d.as_str()).ok_or("fund needs denom")?;
            let amount = st.get("amount").and_then(|d| d.as_str()).ok_or("fund needs string amount")?;
            let amount: Uint128 = amount.parse().map_err(|e| format!("bad amount: {e}"))?;
            cx.app
                .sudo(SudoMsg::Bank(BankSudo::Mint {
                    to_address: to,
                    amount: vec![Coin::new(amount, denom)],
                }))
                .map_err(|e| format!("mint failed: {e:#}"))?;
        }
        "balance" => {
            let addr = cx.reference(st.get("address"), "address")?;
            let denom = st.get("denom").and_then(|d| d.as_str()).ok_or("balance needs denom")?;
            let c = cx
                .app
                .wrap()
                .query_balance(addr, denom)
                .map_err(|e| format!("balance query failed: {e}"))?;
            res.insert("data".into(), json!(c.amount.to_string()));
        }
        "query" => {
            let contract = cx.reference(st.get("contract"), "contract")?;
            let msg = cx.msg(st)?;
            let r: Result<Value, _> = cx.app.wrap().query_wasm_smart(contract, &msg);
            match r {
                Ok(v) => {
                    res.insert("data".into(), v);
                }
                Err(e) => {
                    res.insert("ok".into(), json!(false));
                    res.insert("error".into(), json!(e.to_string()));
                }
            }
        }
        "execute" => {
            let sender = cx.reference(st.get("sender"), "sender")?;
            let contract = cx.reference(st.get("contract"), "contract")?;
            let msg = cx.msg(st)?;
            let funds = cx.funds(st)?;
            match cx.app.execute_contract(Addr::unchecked(sender), Addr::unchecked(contract), &msg, &funds) {
                Ok(r) => {
                    res.insert("attributes".into(), attrs(&r));
                }
                Err(e) => fail(res, &e),
            }
        }
        "instantiate" => {
            let code = st.get("code").and_then(|c| c.as_str()).unwrap_or("app");
            let code_id = *cx
                .codes
                .get(code)
                .ok_or_else(|| format!("unknown code '{code}' (app | cw20-base | cw721-base)"))?;
            let name = st
                .get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| code.to_string());
            if cx.addrs.contains_key(&format!("name:{name}")) {
                return Err(format!("name '{name}' already instantiated"));
            }
            let sender = cx.reference(st.get("sender"), "sender")?;
            let msg = cx.msg(st)?;
            let funds = cx.funds(st)?;
            let admin = match st.get("admin") {
                None | Some(Value::Null) => None,
                v => Some(cx.reference(v, "admin")?),
            };
            let label = st.get("label").and_then(|l| l.as_str()).unwrap_or(&name).to_string();
            let m: CosmosMsg = WasmMsg::Instantiate {
                admin,
                code_id,
                msg: to_json_binary(&msg).map_err(|e| e.to_string())?,
                funds,
                label,
            }
            .into();
            match cx.app.execute(Addr::unchecked(sender), m) {
                Ok(r) => {
                    let addr = r
                        .events
                        .iter()
                        .flat_map(|e| e.attributes.iter())
                        .find(|a| a.key == "_contract_address")
                        .map(|a| a.value.clone())
                        .ok_or("instantiate produced no _contract_address")?;
                    cx.addrs.insert(format!("name:{name}"), addr.clone());
                    if code == "app" {
                        cx.addrs.insert("app".into(), addr.clone());
                    }
                    res.insert("data".into(), json!({ "address": addr }));
                    res.insert("attributes".into(), attrs(&r));
                }
                Err(e) => fail(res, &e),
            }
        }
        other => return Err(format!("unknown op '{other}'")),
    }
    Ok(())
}

fn scenario(plan: &Value, sc: &Value) -> Value {
    let id = sc.get("id").cloned().unwrap_or(Value::Null);
    let prefix = plan.get("bech32_prefix").and_then(|p| p.as_str()).unwrap_or("cosmwasm");
    let clock = plan.get("clock_start").and_then(|c| c.as_u64()).unwrap_or(1_700_000_000);
    let denom = plan.get("native_denom").and_then(|d| d.as_str()).unwrap_or("ucmc");
    let actor_native = plan
        .get("actor_native")
        .and_then(|a| a.as_str())
        .unwrap_or("1000000000000000000000");
    let actors: Vec<String> = plan
        .get("actors")
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    let built = catch_unwind(AssertUnwindSafe(|| -> R<Ctx> {
        let amount: Uint128 = actor_native.parse().map_err(|e| format!("bad actor_native: {e}"))?;
        let mut app: Chain = AppBuilder::new()
            .with_api(MockApiBech32::new(Box::leak(prefix.to_string().into_boxed_str())))
            .build(|_, _, _| {});
        app.set_block(BlockInfo {
            height: 1000,
            time: Timestamp::from_seconds(clock),
            chain_id: "cmc-test".to_string(),
        });
        let mut addrs = BTreeMap::new();
        for a in &actors {
            let ad = app.api().addr_make(a);
            app.sudo(SudoMsg::Bank(BankSudo::Mint {
                to_address: ad.to_string(),
                amount: vec![Coin::new(amount, denom)],
            }))
            .map_err(|e| format!("mint to actor {a}: {e:#}"))?;
            addrs.insert(format!("actor:{a}"), ad.to_string());
        }
        let mut codes = BTreeMap::new();
        codes.insert("app", app.store_code(code_app()));
        codes.insert("cw20-base", app.store_code(code_cw20()));
        codes.insert("cw721-base", app.store_code(code_cw721()));
        Ok(Ctx { app, codes, addrs, actors: actors.clone() })
    }));
    let mut cx = match built {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => return json!({"id": id, "fatal": e, "addresses": {}, "steps": []}),
        Err(_) => return json!({"id": id, "fatal": "panic while building the App", "addresses": {}, "steps": []}),
    };
    let _ = &cx.actors;
    let mut steps = vec![];
    if let Some(list) = sc.get("steps").and_then(|s| s.as_array()) {
        for (i, st) in list.iter().enumerate() {
            steps.push(Value::Object(step(&mut cx, i, st)));
        }
    }
    json!({"id": id, "fatal": null, "addresses": cx.addrs, "steps": steps})
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") {
        println!("{RUNNER} cw-multi-test {CW_MULTI_TEST}");
        return;
    }
    let plan_path = match args.iter().position(|a| a == "--plan") {
        Some(i) if i + 1 < args.len() => args[i + 1].clone(),
        _ => {
            eprintln!("usage: cmc-cosmwasm-runner --plan <plan.json> | --version");
            std::process::exit(2);
        }
    };
    let raw = std::fs::read_to_string(&plan_path).unwrap_or_else(|e| {
        eprintln!("error: cannot read {plan_path}: {e}");
        std::process::exit(3);
    });
    let plan: Value = serde_json::from_str(&raw).unwrap_or_else(|e| {
        eprintln!("error: plan is not valid JSON: {e}");
        std::process::exit(2);
    });
    if plan.get("version").and_then(|v| v.as_u64()) != Some(1) {
        eprintln!("error: plan.version must be 1");
        std::process::exit(2);
    }
    let scs = plan.get("scenarios").and_then(|s| s.as_array()).unwrap_or_else(|| {
        eprintln!("error: plan.scenarios must be an array");
        std::process::exit(2);
    });
    // contract panics are reported per step; keep stderr quiet
    std::panic::set_hook(Box::new(|_| {}));
    let out: Vec<Value> = scs.iter().map(|sc| scenario(&plan, sc)).collect();
    let doc = json!({"runner": RUNNER, "cw_multi_test": CW_MULTI_TEST, "scenarios": out});
    println!("{}", doc);
}
