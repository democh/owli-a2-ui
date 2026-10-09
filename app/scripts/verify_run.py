import json, sqlite3, time, urllib.request, sys

BASE = "http://localhost:3002/api/trpc"
DB = "file:/Users/democh/Desktop/owli/owli-A2UI/app/data/app.db?mode=ro"

def trpc(proc, inp):
    body = json.dumps({"json": inp}).encode()
    req = urllib.request.Request(f"{BASE}/{proc}", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)["result"]["data"]["json"]

def events(run_id):
    con = sqlite3.connect(DB, uri=True)
    rows = con.execute("SELECT seq,type,payload FROM run_events WHERE runId=? ORDER BY seq", (run_id,)).fetchall()
    con.close()
    return [(s, t, json.loads(p)) for s, t, p in rows]

def latest_state(evs):
    st = None
    for s, t, p in evs:
        if t == "run.state":
            st = p.get("status")
    return st

def main():
    out = trpc("runs.create", {
        "projectId": 105, "conversationId": 70, "mode": "create_page",
        "userMessage": "设计一个商城项目", "scope": {}, "baseRevision": 0,
        "idempotencyKey": f"idem_e2e_{int(time.time())}",
        "autonomyLevel": "autopilot", "constraints": {"prototypeMode": True}, "chips": [],
    })
    run_id = out["runId"]
    print(f"[create] {run_id}", flush=True)
    seen = set()
    start = time.time()
    while time.time() - start < 1800:
        evs = events(run_id)
        for s, t, p in evs:
            if s in seen:
                continue
            seen.add(s)
            label = {
                "run.state": f"状态→{p.get('status')}({p.get('progress')})",
                "run.step": f"阶段[{(p.get('card') or {}).get('title')}]{(p.get('card') or {}).get('status')}",
                "run.failed": f"失败:{p.get('message')}",
                "run.cancelled": "已取消",
                "clarification.request": "澄清请求(自动采用推荐默认)",
                "run.plan_approval_required": "计划确认(自动确认)",
            }.get(t)
            if label:
                print(f"  seq{s} {t}: {label}", flush=True)
            if t == "design.validation_failed":
                msgs = [f"[{i.get('code')}]{i.get('path','')} {i.get('message','')[:70]}" for i in (p.get("issues") or [])[:4]]
                print(f"    校验失败(attempt {p.get('attempt')}): {'; '.join(msgs)}", flush=True)
            if t == "clarification.request":
                req = p["request"]
                answers = [{"questionId": q["questionId"], "skipped": True} for q in req["questions"]]
                trpc("runs.clarify", {"requestId": req["requestId"], "runId": run_id, "answers": answers, "submittedAt": time.strftime("%Y-%m-%dT%H:%M:%S")})
                print("    -> 已提交澄清", flush=True)
            if t == "run.plan_approval_required":
                trpc("runs.planApprove", {"runId": run_id, "approved": True})
                print("    -> 已确认计划", flush=True)
            if t == "run.failed":
                print("[FAIL]", p.get("message"), flush=True)
                sys.exit(1)
            if t == "run.cancelled":
                print("[CANCELLED]", flush=True)
                return
        st = latest_state(evs)
        if st in ("completed", "awaiting_approval"):
            print(f"[DONE] 最终状态={st}" + ("(停在等待审批,可在 UI 中审批)" if st == "awaiting_approval" else ""), flush=True)
            return
        time.sleep(6)
    print("[TIMEOUT] 30 分钟未到终态", flush=True)

main()
