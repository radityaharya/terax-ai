use std::io::{BufRead, BufReader, Write};

use serde_json::{json, Value};
use terax_control_protocol::{ControlRequest, ControlResponse, PROTOCOL_VERSION};

const PROTOCOL: u16 = PROTOCOL_VERSION;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("terax-remote {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.get(1).map(String::as_str) != Some("serve") {
        eprintln!("Usage: terax-remote serve");
        eprintln!("Serves Terax remote requests on stdin/stdout (newline-delimited JSON).");
        std::process::exit(2);
    }
    serve();
}

fn serve() {
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut stdout = std::io::stdout().lock();
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let response = handle_line(&line);
        let mut bytes = serde_json::to_vec(&response).unwrap_or_else(|_| b"{}".to_vec());
        bytes.push(b'\n');
        if stdout.write_all(&bytes).is_err() || stdout.flush().is_err() {
            break;
        }
    }
}

fn handle_line(line: &str) -> ControlResponse {
    let request: ControlRequest = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => {
            return ControlResponse::failure(
                terax_control_protocol::SERVER_RESPONSE_ID,
                "invalid_json",
                format!("invalid request JSON: {e}"),
            );
        }
    };
    if request.protocol != PROTOCOL {
        return ControlResponse::failure(
            request.id,
            "unsupported_protocol",
            format!("protocol {} unsupported; expected {PROTOCOL}", request.protocol),
        );
    }
    match request.method.as_str() {
        "ping" => ControlResponse::success(
            request.id,
            json!({ "pong": true, "app_version": env!("CARGO_PKG_VERSION"), "protocol": PROTOCOL }),
        ),
        "capabilities" => ControlResponse::success(
            request.id,
            json!({
                "app_version": env!("CARGO_PKG_VERSION"),
                "protocol": PROTOCOL,
                "methods": ["ping", "capabilities"],
            }),
        ),
        _ => ControlResponse::failure(request.id, "unknown_method", "unknown remote method"),
    }
}

pub fn result_value(v: Value) -> Value {
    v
}
