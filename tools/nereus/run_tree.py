#!/usr/bin/env python3
"""Run an autonomy tree against the running sim, log the subtree stack with sim time."""
import json, sys, time
import rclpy
from rclpy.action import ActionClient
from rclpy.node import Node
from riptide_msgs2.action import ExecuteTree
from riptide_msgs2.msg import KillSwitchReport
from rosgraph_msgs.msg import Clock
from std_msgs.msg import String

tree, out = sys.argv[1], sys.argv[2]
timeout = float(sys.argv[3]) if len(sys.argv) > 3 else 1800
rclpy.init()
node = Node("perc_driver", namespace="/talos")
clock = {"t": 0.0}
node.create_subscription(Clock, "/clock", lambda m: clock.update(t=m.clock.sec + m.clock.nanosec * 1e-9), 10)
kill = node.create_publisher(KillSwitchReport, "command/software_kill", 10)
run = node.create_publisher(String, "simulator/run_command", 10)
client = ActionClient(node, ExecuteTree, "autonomy/run_tree")
log = []
assert client.wait_for_server(timeout_sec=60)
for a in ("stop", "start"):
    run.publish(String(data=json.dumps({"action": a})))
    for _ in range(5): rclpy.spin_once(node, timeout_sec=0.1)
def fb(m):
    st = list(m.feedback.stack.stack)
    if not log or log[-1]["stack"] != st:
        log.append({"sim_s": round(clock["t"], 3), "stack": st}); print(round(clock["t"],1), st[-1] if st else "", flush=True)
fut = client.send_goal_async(ExecuteTree.Goal(tree=tree), feedback_callback=fb)
rclpy.spin_until_future_complete(node, fut, timeout_sec=30)
h = fut.result(); assert h and h.accepted
start = time.monotonic(); rel = False
res = h.get_result_async()
while not res.done():
    rclpy.spin_once(node, timeout_sec=0.1)
    if not rel and time.monotonic() - start > 8:
        kill.publish(KillSwitchReport(kill_switch_id=1, switch_asserting_kill=False)); rel = True
    if time.monotonic() - start > timeout:
        h.cancel_goal_async(); break
r = {"log": log, "sim_s": clock["t"]}
if res.done(): r.update(error=bool(res.result().result.error), returncode=int(res.result().result.returncode))
json.dump(r, open(out, "w"), indent=1)
print("done", r.get("returncode"), flush=True)
