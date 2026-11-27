# 本地逻辑自检：用假的 machine/time/uselect 驱动真实的 main.py。
# 验证固件逻辑（限位、回中、PWM 映射、动作序列、状态输出），不依赖 Wokwi。
# 运行：python hardware/sim/wokwi/selftest.py

import contextlib
import io
import json
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
FIRMWARE = os.path.join(HERE, "main.py")

clock = {"ms": 0}
duties = {}
led = {"on": False, "changes": 0}
commands = ["pan 100", "tilt -100", "nod", "left", "state"]
LIMIT_MS = 10000


class FakePWM:
    def __init__(self, pin, freq=50):
        self.pin = pin.number
        duties.setdefault(self.pin, [])

    def duty_u16(self, value):
        duties[self.pin].append(int(value))


class FakePin:
    OUT = 1

    def __init__(self, number, mode=None):
        self.number = number

    def on(self):
        led["on"] = True
        led["changes"] += 1

    def off(self):
        led["on"] = False
        led["changes"] += 1


class FakePoll:
    def __init__(self):
        self.targets = []

    def register(self, obj, event=None):
        self.targets.append(obj)

    def poll(self, timeout=0):
        return [(self.targets[0], 1)] if commands else []


class FakeStdin:
    def readline(self):
        return commands.pop(0) + "\n"


def install_stubs():
    machine = types.ModuleType("machine")
    machine.Pin = FakePin
    machine.PWM = FakePWM
    sys.modules["machine"] = machine

    uselect = types.ModuleType("uselect")
    uselect.POLLIN = 1
    uselect.poll = FakePoll
    sys.modules["uselect"] = uselect

    fake_time = types.ModuleType("time")

    def sleep_ms(ms):
        clock["ms"] += ms
        if clock["ms"] > LIMIT_MS:
            raise SystemExit

    fake_time.sleep_ms = sleep_ms
    fake_time.ticks_ms = lambda: clock["ms"]
    fake_time.ticks_diff = lambda a, b: a - b
    sys.modules["time"] = fake_time

    sys.stdin = FakeStdin()


def run_firmware():
    with open(FIRMWARE, "r", encoding="utf-8") as fh:
        source = fh.read()
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        try:
            exec(compile(source, FIRMWARE, "exec"), {"__name__": "__main__"})
        except SystemExit:
            pass
    return buffer.getvalue()


def events(text):
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        out.append(json.loads(line))
    return out


def main():
    install_stubs()
    text = run_firmware()
    evs = events(text)

    def find(**fields):
        return [e for e in evs if all(e.get(k) == v for k, v in fields.items())]

    assert duties.get(4), "pan 舵机(GPIO4)应收到 PWM"
    assert duties.get(5), "tilt 舵机(GPIO5)应收到 PWM"
    assert led["changes"] > 0, "动作时状态灯应亮灭"

    assert find(event="center", reason="boot"), "上电应回中"
    assert any(e.get("event") == "nod" for e in evs), "应产生 nod 事件"

    pan_clamped = [e for e in evs if e.get("axis") == "pan" and e.get("clamped") is True]
    tilt_clamped = [e for e in evs if e.get("axis") == "tilt" and e.get("clamped") is True]
    assert pan_clamped and pan_clamped[-1]["pan"] == 60, "pan 100 应被夹到 60"
    assert tilt_clamped and tilt_clamped[-1]["tilt"] == -30, "tilt -100 应被夹到 -30"

    # 逻辑 +60° -> 舵机 150° -> duty 约 6007；-30° -> 60° -> duty 约 4369（浮点截断允许 ±1）
    assert any(abs(d - 6007) <= 1 for d in duties[4]), f"pan 端点脉宽不对：{sorted(set(duties[4]))[-5:]}"
    assert any(abs(d - 4369) <= 1 for d in duties[5]), f"tilt 端点脉宽不对：{sorted(set(duties[5]))[-5:]}"
    assert all(3277 <= d <= 6553 for d in duties[4] + duties[5]), "脉宽必须落在 1–2ms"

    left = [e for e in evs if e.get("axis") == "pan" and e.get("pan") == 35]
    assert left, "left 应把 pan 从 60 收到 35"

    idle = find(event="center", reason="idle_timeout")
    assert idle, "空闲 3 秒应自动回中"
    assert evs[-1]["pan"] == 0 and evs[-1]["tilt"] == 0, "最终姿态应回中"

    print("Wokwi 固件逻辑自检通过：上电回中 → 限位夹紧 → nod 序列 → left → 空闲回中")
    print(f"  pan PWM {len(duties[4])} 帧 / tilt PWM {len(duties[5])} 帧 / 灯变化 {led['changes']} 次")


if __name__ == "__main__":
    main()
