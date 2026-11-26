//! Minimal JSON-RPC client (HTTP/1.1 over std TcpStream, no TLS) for the `live` mode.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use solana_address::Address;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::str::FromStr;
use std::time::{Duration, Instant};

type R<T> = Result<T, String>;

pub struct Acct {
    pub lamports: u64,
    pub data: Vec<u8>,
    pub owner: Address,
    pub executable: bool,
}

pub struct Rpc {
    addr: String,
    path: String,
}

fn dechunk(b: &[u8]) -> Vec<u8> {
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        let Some(p) = b[i..].windows(2).position(|w| w == b"\r\n") else { break };
        let line = String::from_utf8_lossy(&b[i..i + p]).to_string();
        let size = usize::from_str_radix(line.split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        i += p + 2;
        if size == 0 || i + size > b.len() {
            if size != 0 {
                out.extend(&b[i..]);
            }
            break;
        }
        out.extend(&b[i..i + size]);
        i += size + 2;
    }
    out
}

/// Format a JSON-RPC TransactionError the way TransactionError's Display does, plus the custom code.
pub fn fmt_tx_err(e: &Value) -> (String, Option<u32>) {
    if let Some(arr) = e.get("InstructionError").and_then(|a| a.as_array()) {
        let idx = arr.first().and_then(|x| x.as_u64()).unwrap_or(0);
        let inner = arr.get(1).cloned().unwrap_or(Value::Null);
        if let Some(c) = inner.get("Custom").and_then(|c| c.as_u64()) {
            return (format!("Error processing Instruction {idx}: custom program error: {c:#x}"), Some(c as u32));
        }
        return (format!("Error processing Instruction {idx}: {}", inner.as_str().map(|s| s.to_string()).unwrap_or_else(|| inner.to_string())), None);
    }
    (e.as_str().map(|s| s.to_string()).unwrap_or_else(|| e.to_string()), None)
}

impl Rpc {
    pub fn new(url: &str) -> R<Rpc> {
        let rest = url.strip_prefix("http://").ok_or("rpc url must start with http://")?;
        let (hp, path) = match rest.find('/') {
            Some(i) => (&rest[..i], rest[i..].to_string()),
            None => (rest, "/".to_string()),
        };
        let addr = if hp.contains(':') { hp.to_string() } else { format!("{hp}:80") };
        Ok(Rpc { addr, path })
    }

    pub fn call(&self, method: &str, params: Value) -> R<Value> {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).to_string();
        let mut s = TcpStream::connect(&self.addr).map_err(|e| format!("rpc connect {}: {e}", self.addr))?;
        s.set_read_timeout(Some(Duration::from_secs(60))).ok();
        s.set_write_timeout(Some(Duration::from_secs(30))).ok();
        let req = format!("POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", self.path, self.addr, body.len(), body);
        s.write_all(req.as_bytes()).map_err(|e| format!("rpc write: {e}"))?;
        let mut buf = vec![];
        s.read_to_end(&mut buf).map_err(|e| format!("rpc read: {e}"))?;
        let split = buf.windows(4).position(|w| w == b"\r\n\r\n").ok_or("rpc: malformed HTTP response")?;
        let head = String::from_utf8_lossy(&buf[..split]).to_lowercase();
        let status = head.lines().next().unwrap_or("");
        if !status.contains(" 200") {
            return Err(format!("rpc http status: {status}"));
        }
        let body = &buf[split + 4..];
        let body = if head.contains("transfer-encoding: chunked") { dechunk(body) } else { body.to_vec() };
        let v: Value = serde_json::from_slice(&body).map_err(|e| format!("rpc: bad JSON: {e}"))?;
        if let Some(e) = v.get("error") {
            return Err(format!("rpc error: {}", e["message"].as_str().map(|s| s.to_string()).unwrap_or_else(|| e.to_string())));
        }
        Ok(v["result"].clone())
    }

    pub fn get_account(&self, a: &Address) -> R<Option<Acct>> {
        let r = self.call("getAccountInfo", json!([a.to_string(), {"encoding": "base64", "commitment": "confirmed"}]))?;
        let v = &r["value"];
        if v.is_null() {
            return Ok(None);
        }
        let data = B64.decode(v["data"][0].as_str().unwrap_or("")).map_err(|e| format!("bad account data: {e}"))?;
        Ok(Some(Acct {
            lamports: v["lamports"].as_u64().unwrap_or(0),
            data,
            owner: Address::from_str(v["owner"].as_str().unwrap_or("")).map_err(|_| "bad owner")?,
            executable: v["executable"].as_bool().unwrap_or(false),
        }))
    }

    pub fn latest_blockhash(&self) -> R<Address> {
        let r = self.call("getLatestBlockhash", json!([{"commitment": "confirmed"}]))?;
        Address::from_str(r["value"]["blockhash"].as_str().unwrap_or("")).map_err(|_| "bad blockhash".to_string())
    }

    pub fn send_raw(&self, wire: &[u8]) -> R<String> {
        let r = self.call("sendTransaction", json!([B64.encode(wire), {"encoding": "base64", "skipPreflight": true, "preflightCommitment": "confirmed"}]))?;
        r.as_str().map(|s| s.to_string()).ok_or_else(|| "sendTransaction: no signature".to_string())
    }

    /// Wait until the signature is at least confirmed (it may have failed on chain).
    pub fn confirm(&self, sig: &str) -> R<()> {
        let t = Instant::now();
        loop {
            let r = self.call("getSignatureStatuses", json!([[sig]]))?;
            let st = &r["value"][0];
            if !st.is_null() && matches!(st["confirmationStatus"].as_str(), Some("confirmed") | Some("finalized")) {
                return Ok(());
            }
            if t.elapsed() > Duration::from_secs(60) {
                return Err(format!("timeout waiting for confirmation of {sig}"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    pub fn get_tx(&self, sig: &str) -> R<Value> {
        for _ in 0..50 {
            let r = self.call("getTransaction", json!([sig, {"encoding": "json", "commitment": "confirmed", "maxSupportedTransactionVersion": 0}]))?;
            if !r.is_null() {
                return Ok(r);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(format!("getTransaction returned nothing for {sig}"))
    }

    pub fn request_airdrop(&self, a: &Address, lamports: u64) -> R<String> {
        let r = self.call("requestAirdrop", json!([a.to_string(), lamports, {"commitment": "confirmed"}]))?;
        r.as_str().map(|s| s.to_string()).ok_or_else(|| "requestAirdrop: no signature".to_string())
    }
}
