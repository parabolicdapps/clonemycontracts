//! Anchor IDL (0.30+/1.x format) helpers: borsh encode/decode of IDL types from/to JSON.
use serde_json::{json, Map, Value};

pub type R<T> = Result<T, String>;

/// Callbacks into the scenario: resolve a Ref to 32 bytes, and map known pubkeys to Ref strings.
pub struct Env<'a> {
    pub resolve: &'a dyn Fn(&Value) -> R<[u8; 32]>,
    pub show: &'a dyn Fn(&[u8; 32]) -> String,
    /// replace known entity pubkeys by Ref strings in decoded output
    pub subst: bool,
}

pub fn norm(s: &str) -> String {
    s.chars().filter(|c| *c != '_' && *c != '.').flat_map(|c| c.to_lowercase()).collect()
}

pub fn get_ci<'a>(m: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    if let Some(v) = m.get(key) {
        return Some(v);
    }
    let n = norm(key);
    m.iter().find(|(k, _)| norm(k) == n).map(|(_, v)| v)
}

pub fn hex_decode(s: &str) -> R<Vec<u8>> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() % 2 != 0 {
        return Err(format!("odd-length hex '{s}'"));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| format!("bad hex '{s}'")))
        .collect()
}

pub fn find_type_def<'a>(idl: &'a Value, name: &str) -> Option<&'a Value> {
    idl.get("types")?.as_array()?.iter().find(|t| t["name"] == name)
}

fn int_spec(name: &str) -> Option<(bool, u32)> {
    Some(match name {
        "u8" => (false, 8),
        "u16" => (false, 16),
        "u32" => (false, 32),
        "u64" => (false, 64),
        "u128" => (false, 128),
        "i8" => (true, 8),
        "i16" => (true, 16),
        "i32" => (true, 32),
        "i64" => (true, 64),
        "i128" => (true, 128),
        _ => return None,
    })
}

pub fn int_bytes(name: &str, val: &Value) -> R<Vec<u8>> {
    let (signed, bits) = int_spec(name).ok_or_else(|| format!("not an int type: {name}"))?;
    let s = match val {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => return Err(format!("expected {name} as decimal string or number, got {val}")),
    };
    let nbytes = (bits / 8) as usize;
    if signed {
        let x: i128 = s.parse().map_err(|_| format!("bad {name} value '{s}'"))?;
        if bits < 128 {
            let lim = 1i128 << (bits - 1);
            if x < -lim || x >= lim {
                return Err(format!("{name} value {x} out of range"));
            }
        }
        Ok(x.to_le_bytes()[..nbytes].to_vec())
    } else {
        let x: u128 = s.parse().map_err(|_| format!("bad {name} value '{s}'"))?;
        if bits < 128 && x >= (1u128 << bits) {
            return Err(format!("{name} value {x} out of range"));
        }
        Ok(x.to_le_bytes()[..nbytes].to_vec())
    }
}

pub fn parse_u64(val: &Value) -> R<u64> {
    let b = int_bytes("u64", val)?;
    Ok(u64::from_le_bytes(b.try_into().unwrap()))
}

fn bytes_value(val: &Value) -> R<Vec<u8>> {
    match val {
        Value::String(s) => hex_decode(s),
        Value::Array(a) => a
            .iter()
            .map(|x| x.as_u64().filter(|n| *n < 256).map(|n| n as u8).ok_or_else(|| "bad byte in array".to_string()))
            .collect(),
        Value::Object(o) if o.contains_key("hex") => hex_decode(o["hex"].as_str().unwrap_or("")),
        Value::Object(o) if o.contains_key("str") => Ok(o["str"].as_str().unwrap_or("").as_bytes().to_vec()),
        _ => Err(format!("expected bytes (hex string / byte array / {{\"hex\":..}}), got {val}")),
    }
}

fn defined_name(d: &Value) -> Option<&str> {
    match d {
        Value::String(s) => Some(s),
        Value::Object(o) => o.get("name").and_then(|n| n.as_str()),
        _ => None,
    }
}

fn is_named_fields(fields: &[Value]) -> bool {
    fields.first().map_or(false, |f| f.as_object().map_or(false, |o| o.contains_key("name") && o.contains_key("type")))
}

pub fn encode(idl: &Value, ty: &Value, val: &Value, env: &Env, out: &mut Vec<u8>) -> R<()> {
    match ty {
        Value::String(s) => match s.as_str() {
            "bool" => {
                out.push(val.as_bool().ok_or_else(|| format!("expected bool, got {val}"))? as u8);
            }
            "f32" => out.extend((val.as_f64().ok_or("expected number")? as f32).to_le_bytes()),
            "f64" => out.extend(val.as_f64().ok_or("expected number")?.to_le_bytes()),
            "pubkey" | "publicKey" => out.extend((env.resolve)(val)?),
            "string" => {
                let st = val.as_str().ok_or_else(|| format!("expected string, got {val}"))?;
                out.extend((st.len() as u32).to_le_bytes());
                out.extend(st.as_bytes());
            }
            "bytes" => {
                let b = bytes_value(val)?;
                out.extend((b.len() as u32).to_le_bytes());
                out.extend(b);
            }
            n if int_spec(n).is_some() => out.extend(int_bytes(n, val)?),
            other => return Err(format!("unsupported IDL type '{other}'")),
        },
        Value::Object(o) => {
            if let Some(inner) = o.get("vec") {
                if inner == "u8" && !val.is_array() {
                    let b = bytes_value(val)?;
                    out.extend((b.len() as u32).to_le_bytes());
                    out.extend(b);
                } else {
                    let a = val.as_array().ok_or_else(|| format!("expected array, got {val}"))?;
                    out.extend((a.len() as u32).to_le_bytes());
                    for x in a {
                        encode(idl, inner, x, env, out)?;
                    }
                }
            } else if let Some(arr) = o.get("array") {
                let inner = &arr[0];
                let n = arr[1].as_u64().ok_or("bad array length")? as usize;
                if inner == "u8" && !val.is_array() {
                    let b = bytes_value(val)?;
                    if b.len() != n {
                        return Err(format!("expected {n} bytes, got {}", b.len()));
                    }
                    out.extend(b);
                } else {
                    let a = val.as_array().ok_or_else(|| format!("expected array of {n}, got {val}"))?;
                    if a.len() != n {
                        return Err(format!("expected array of {n}, got {}", a.len()));
                    }
                    for x in a {
                        encode(idl, inner, x, env, out)?;
                    }
                }
            } else if let Some(inner) = o.get("option") {
                if val.is_null() {
                    out.push(0);
                } else {
                    out.push(1);
                    encode(idl, inner, val, env, out)?;
                }
            } else if let Some(inner) = o.get("coption") {
                if val.is_null() {
                    out.extend(0u32.to_le_bytes());
                } else {
                    out.extend(1u32.to_le_bytes());
                    encode(idl, inner, val, env, out)?;
                }
            } else if let Some(d) = o.get("defined") {
                let name = defined_name(d).ok_or("bad defined type")?;
                let def = find_type_def(idl, name).ok_or_else(|| format!("type '{name}' not in IDL"))?;
                encode_def(idl, def, val, env, out)?;
            } else {
                return Err(format!("unsupported IDL type {ty}"));
            }
        }
        _ => return Err(format!("unsupported IDL type {ty}")),
    }
    Ok(())
}

fn encode_def(idl: &Value, def: &Value, val: &Value, env: &Env, out: &mut Vec<u8>) -> R<()> {
    let t = &def["type"];
    match t["kind"].as_str() {
        Some("struct") => {
            let fields = t.get("fields").and_then(|f| f.as_array()).cloned().unwrap_or_default();
            if is_named_fields(&fields) {
                let obj = val.as_object().ok_or_else(|| format!("expected object for struct {}", def["name"]))?;
                for f in &fields {
                    let fname = f["name"].as_str().unwrap_or("");
                    let v = get_ci(obj, fname);
                    let v = match v {
                        Some(v) => v,
                        None if matches!(f["type"].get("option"), Some(_)) => &Value::Null,
                        None => return Err(format!("missing field '{fname}' of {}", def["name"])),
                    };
                    encode(idl, &f["type"], v, env, out).map_err(|e| format!("{fname}: {e}"))?;
                }
            } else if !fields.is_empty() {
                let a = val.as_array().ok_or("expected array for tuple struct")?;
                if a.len() != fields.len() {
                    return Err("tuple struct length mismatch".into());
                }
                for (f, v) in fields.iter().zip(a) {
                    encode(idl, f, v, env, out)?;
                }
            }
            Ok(())
        }
        Some("enum") => {
            let variants = t["variants"].as_array().ok_or("bad enum")?;
            let (vname, payload): (String, Value) = match val {
                Value::String(s) => (s.clone(), Value::Null),
                Value::Object(o) if o.len() == 1 => {
                    let (k, v) = o.iter().next().unwrap();
                    (k.clone(), v.clone())
                }
                _ => return Err(format!("expected enum value for {}: \"Variant\" or {{\"Variant\":..}}", def["name"])),
            };
            let (idx, var) = variants
                .iter()
                .enumerate()
                .find(|(_, v)| norm(v["name"].as_str().unwrap_or("")) == norm(&vname))
                .ok_or_else(|| format!("unknown variant '{vname}' of {}", def["name"]))?;
            out.push(idx as u8);
            if let Some(fields) = var.get("fields").and_then(|f| f.as_array()) {
                if is_named_fields(fields) {
                    let obj = payload.as_object().ok_or("expected object payload")?;
                    for f in fields {
                        let fname = f["name"].as_str().unwrap_or("");
                        let v = get_ci(obj, fname).ok_or_else(|| format!("missing field '{fname}'"))?;
                        encode(idl, &f["type"], v, env, out)?;
                    }
                } else {
                    let a = payload.as_array().ok_or("expected array payload")?;
                    for (f, v) in fields.iter().zip(a) {
                        encode(idl, f, v, env, out)?;
                    }
                }
            }
            Ok(())
        }
        Some("type") => encode(idl, &t["alias"], val, env, out),
        _ => Err(format!("unsupported type def {}", def["name"])),
    }
}

struct Cur<'a> {
    b: &'a [u8],
}
impl<'a> Cur<'a> {
    fn take(&mut self, n: usize) -> R<&'a [u8]> {
        if self.b.len() < n {
            return Err("unexpected end of data".into());
        }
        let (h, t) = self.b.split_at(n);
        self.b = t;
        Ok(h)
    }
}

#[allow(dead_code)]
pub fn decode(idl: &Value, ty: &Value, data: &[u8], env: &Env) -> R<Value> {
    let mut c = Cur { b: data };
    dec(idl, ty, &mut c, env)
}

/// Decode a struct/enum/alias type definition by name (account data).
pub fn decode_named(idl: &Value, name: &str, data: &[u8], env: &Env) -> R<Value> {
    let def = find_type_def(idl, name).ok_or_else(|| format!("type '{name}' not in IDL types"))?;
    let mut c = Cur { b: data };
    dec_def(idl, def, &mut c, env)
}

fn dec(idl: &Value, ty: &Value, c: &mut Cur, env: &Env) -> R<Value> {
    Ok(match ty {
        Value::String(s) => match s.as_str() {
            "bool" => json!(c.take(1)?[0] != 0),
            "f32" => json!(f32::from_le_bytes(c.take(4)?.try_into().unwrap())),
            "f64" => json!(f64::from_le_bytes(c.take(8)?.try_into().unwrap())),
            "pubkey" | "publicKey" => {
                let k: [u8; 32] = c.take(32)?.try_into().unwrap();
                if env.subst {
                    json!((env.show)(&k))
                } else {
                    json!(solana_address::Address::new_from_array(k).to_string())
                }
            }
            "string" => {
                let n = u32::from_le_bytes(c.take(4)?.try_into().unwrap()) as usize;
                json!(String::from_utf8_lossy(c.take(n)?).to_string())
            }
            "bytes" => {
                let n = u32::from_le_bytes(c.take(4)?.try_into().unwrap()) as usize;
                json!(c.take(n)?.iter().map(|b| *b as u64).collect::<Vec<_>>())
            }
            n if int_spec(n).is_some() => {
                let (signed, bits) = int_spec(n).unwrap();
                let raw = c.take((bits / 8) as usize)?;
                let mut buf = [0u8; 16];
                buf[..raw.len()].copy_from_slice(raw);
                if signed {
                    let mut x = i128::from_le_bytes(buf);
                    if bits < 128 {
                        x = (x << (128 - bits)) >> (128 - bits);
                    }
                    json!(x.to_string())
                } else {
                    let x = u128::from_le_bytes(buf);
                    if bits <= 32 {
                        json!(x as u64)
                    } else {
                        json!(x.to_string())
                    }
                }
            }
            other => return Err(format!("unsupported IDL type '{other}'")),
        },
        Value::Object(o) => {
            if let Some(inner) = o.get("vec") {
                let n = u32::from_le_bytes(c.take(4)?.try_into().unwrap()) as usize;
                if n > 1_000_000 {
                    return Err("vec too long".into());
                }
                let mut v = Vec::new();
                for _ in 0..n {
                    v.push(dec(idl, inner, c, env)?);
                }
                Value::Array(v)
            } else if let Some(arr) = o.get("array") {
                let n = arr[1].as_u64().ok_or("bad array length")? as usize;
                let mut v = Vec::new();
                for _ in 0..n {
                    v.push(dec(idl, &arr[0], c, env)?);
                }
                Value::Array(v)
            } else if let Some(inner) = o.get("option") {
                if c.take(1)?[0] == 0 {
                    Value::Null
                } else {
                    dec(idl, inner, c, env)?
                }
            } else if let Some(inner) = o.get("coption") {
                if u32::from_le_bytes(c.take(4)?.try_into().unwrap()) == 0 {
                    Value::Null
                } else {
                    dec(idl, inner, c, env)?
                }
            } else if let Some(d) = o.get("defined") {
                let name = defined_name(d).ok_or("bad defined type")?;
                let def = find_type_def(idl, name).ok_or_else(|| format!("type '{name}' not in IDL"))?;
                dec_def(idl, def, c, env)?
            } else {
                return Err(format!("unsupported IDL type {ty}"));
            }
        }
        _ => return Err(format!("unsupported IDL type {ty}")),
    })
}

fn dec_def(idl: &Value, def: &Value, c: &mut Cur, env: &Env) -> R<Value> {
    let t = &def["type"];
    match t["kind"].as_str() {
        Some("struct") => {
            let fields = t.get("fields").and_then(|f| f.as_array()).cloned().unwrap_or_default();
            if is_named_fields(&fields) {
                let mut m = Map::new();
                for f in &fields {
                    m.insert(f["name"].as_str().unwrap_or("").to_string(), dec(idl, &f["type"], c, env)?);
                }
                Ok(Value::Object(m))
            } else {
                let mut v = Vec::new();
                for f in &fields {
                    v.push(dec(idl, f, c, env)?);
                }
                Ok(Value::Array(v))
            }
        }
        Some("enum") => {
            let idx = c.take(1)?[0] as usize;
            let var = t["variants"].as_array().and_then(|v| v.get(idx)).ok_or("bad enum variant index")?;
            let name = var["name"].as_str().unwrap_or("").to_string();
            match var.get("fields").and_then(|f| f.as_array()) {
                None => Ok(json!(name)),
                Some(fields) if fields.is_empty() => Ok(json!(name)),
                Some(fields) if is_named_fields(fields) => {
                    let mut m = Map::new();
                    for f in fields {
                        m.insert(f["name"].as_str().unwrap_or("").to_string(), dec(idl, &f["type"], c, env)?);
                    }
                    Ok(json!({ name: Value::Object(m) }))
                }
                Some(fields) => {
                    let mut v = Vec::new();
                    for f in fields {
                        v.push(dec(idl, f, c, env)?);
                    }
                    Ok(json!({ name: v }))
                }
            }
        }
        Some("type") => dec(idl, &t["alias"], c, env),
        _ => Err(format!("unsupported type def {}", def["name"])),
    }
}

/// Type of a (possibly dotted) field path inside a type.
pub fn field_type(idl: &Value, ty: &Value, path: &[&str]) -> R<Value> {
    if path.is_empty() {
        return Ok(ty.clone());
    }
    let name = ty.get("defined").and_then(defined_name).ok_or("field path into a non-struct type")?;
    let def = find_type_def(idl, name).ok_or_else(|| format!("type '{name}' not in IDL"))?;
    let fields = def["type"]["fields"].as_array().ok_or("not a struct")?;
    let f = fields
        .iter()
        .find(|f| norm(f["name"].as_str().unwrap_or("")) == norm(path[0]))
        .ok_or_else(|| format!("no field '{}' in {name}", path[0]))?;
    field_type(idl, &f["type"], &path[1..])
}

/// PDA seed bytes for a value of the given IDL type (strings/bytes are raw, like Anchor's TS client).
pub fn seed_bytes(idl: &Value, ty: &Value, val: &Value, env: &Env) -> R<Vec<u8>> {
    match ty {
        Value::String(s) if s == "string" => Ok(val.as_str().ok_or("expected string seed")?.as_bytes().to_vec()),
        Value::String(s) if s == "bytes" => bytes_value(val),
        Value::Object(o) if o.get("vec").map_or(false, |v| v == "u8") => bytes_value(val),
        _ => {
            let mut out = Vec::new();
            encode(idl, ty, val, env, &mut out)?;
            Ok(out)
        }
    }
}

pub fn navigate<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for p in path {
        cur = match cur {
            Value::Array(a) => a.get(p.parse::<usize>().ok()?)?,
            _ => get_ci(cur.as_object()?, p)?,
        };
    }
    Some(cur)
}
