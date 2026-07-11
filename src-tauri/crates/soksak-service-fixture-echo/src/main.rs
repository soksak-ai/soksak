//! E2E fixture — the smallest possible plugin service (PS17/PS18). It borrows
//! the shared serve harness and implements two ops (`echo`, `add`) and nothing
//! else: no framing, no hello, no multiplex — all of that is the harness.
//! Its job is to prove the whole service-axis path end to end (manifest →
//! ledger → bind → spawn → hello → route → dispatch → res, plus a mediated
//! `cmd` and a `serve` subcommand) without any plugin domain logic.

use serde_json::{json, Value};
use soksak_service_proto::{serve_stdio, Emit, ErrCode, OpCtx, Outcome, ServiceHandler};

struct Echo;

impl ServiceHandler for Echo {
    fn ops(&self) -> Vec<String> {
        vec!["echo".into(), "add".into(), "relay".into()]
    }

    fn read_only(&self, op: &str) -> bool {
        op == "echo"
    }

    fn handle(&self, op: &str, params: Value, ctx: &OpCtx, emit: &Emit) -> Outcome {
        match op {
            // echo — 받은 params 를 그대로 되돌린다(라운드트립 증명). origin 도 실어 코어 스탬핑 확인.
            "echo" => Outcome::ok_msg(
                json!({ "echo": params, "origin": ctx.origin }),
                "에코 완료",
            ),
            // add — 진행 ev 를 흘린 뒤 합을 낸다(스트리밍 + 마감 연장 증명).
            "add" => {
                let a = params.get("a").and_then(Value::as_i64).unwrap_or(0);
                let b = params.get("b").and_then(Value::as_i64).unwrap_or(0);
                emit.progress("progress", json!({ "step": "adding" }));
                Outcome::ok_msg(json!({ "sum": a + b }), "합산 완료")
            }
            // relay — 선언 의존성을 통해 다른 커맨드를 중개 호출(PS13 왕복 증명).
            "relay" => {
                let method = params.get("method").and_then(Value::as_str).unwrap_or("state.tree");
                let reply = emit.call(method, json!({}), Some("relay#1"));
                Outcome::ok(json!({ "relayed": reply }))
            }
            other => Outcome::err(ErrCode::UnknownOp, other),
        }
    }
}

fn main() {
    let mode = std::env::args().nth(1);
    match mode.as_deref() {
        // 표준 진입점(PS18) — 코어가 `<bin> serve` 로 스폰한다.
        Some("serve") => serve_stdio(Echo),
        // 저장소 내부 하네스(PS2 — 완결 증거 불인정): 단발 자기점검용.
        Some("selfcheck") => {
            println!("{}", json!({ "ok": true, "ops": Echo.ops() }));
        }
        _ => {
            eprintln!("usage: soksak-sidecar-e2e-echo serve|selfcheck");
            std::process::exit(2);
        }
    }
}
