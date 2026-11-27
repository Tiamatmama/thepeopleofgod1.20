# 桌面半身 · 固件级仿真（Wokwi / MicroPython / ESP32-S3）
#
# 只验证固件逻辑：PWM 角度映射、软件限位、上电回中、动作序列、状态输出。
# 电气注意：真机上两个舵机的 5V 必须来自独立 5V/3A 适配器并与 ESP32 共地，
# 不要从开发板 5V 引脚取电；diagram.json 里接 esp:5V 只是仿真占位。
#
# 逻辑角度以 0 为居中：pan -60..60，tilt -30..60（比 spec 的物理极限更窄，
# 给机械挡块和走线留余量）。

from machine import Pin, PWM
from time import sleep_ms, ticks_ms, ticks_diff
import sys
import uselect

PAN_PIN = 4
TILT_PIN = 5
LED_PIN = 15

PAN_MIN, PAN_MAX = -60, 60
TILT_MIN, TILT_MAX = -30, 60
IDLE_CENTER_MS = 3000
STEP_DEG = 2
STEP_MS = 12

pan_pwm = PWM(Pin(PAN_PIN), freq=50)
tilt_pwm = PWM(Pin(TILT_PIN), freq=50)
led = Pin(LED_PIN, Pin.OUT)

state = {"pan": 0, "tilt": 0}
last_cmd = ticks_ms()


def pulse(pwm, servo_deg):
    # 0..180 映射到 1..2ms 脉宽（50Hz）
    duty = int(3277 + (servo_deg / 180) * (6553 - 3277))
    pwm.duty_u16(duty)


def clamp(value, low, high):
    if value < low:
        return low, True
    if value > high:
        return high, True
    return value, False


def report(event, extra=""):
    print('{"event":"%s","pan":%d,"tilt":%d%s}' % (event, state["pan"], state["tilt"], extra))


def move_axis(axis, target):
    global last_cmd
    if axis == "pan":
        target, clamped = clamp(target, PAN_MIN, PAN_MAX)
        pwm, current = pan_pwm, state["pan"]
    else:
        target, clamped = clamp(target, TILT_MIN, TILT_MAX)
        pwm, current = tilt_pwm, state["tilt"]

    led.on()
    step = STEP_DEG if target >= current else -STEP_DEG
    value = current
    while value != target:
        value += step
        if (step > 0 and value > target) or (step < 0 and value < target):
            value = target
        state[axis] = value
        pulse(pwm, 90 + value)
        sleep_ms(STEP_MS)
    led.off()

    last_cmd = ticks_ms()
    report("state", ',"clamped":%s,"axis":"%s"' % ("true" if clamped else "false", axis))
    return clamped


def nod():
    move_axis("tilt", 0)
    move_axis("tilt", -12)
    move_axis("tilt", 10)
    move_axis("tilt", 0)
    report("nod")


def center(reason="manual"):
    move_axis("pan", 0)
    move_axis("tilt", 0)
    report("center", ',"reason":"%s"' % reason)


def demo():
    center("demo")
    nod()
    move_axis("pan", -30)
    center("demo")
    move_axis("pan", 30)
    center("demo")
    report("demo")


def help_text():
    print("# pan <角度> | tilt <角度> | nod | left | right | center | demo | state | help")


def handle(line):
    parts = line.split()
    if not parts:
        return
    cmd = parts[0].lower()

    if cmd == "help":
        help_text()
        return
    if cmd == "state":
        report("state")
        return
    if cmd == "nod":
        nod()
        return
    if cmd == "center":
        center("manual")
        return
    if cmd == "demo":
        demo()
        return
    if cmd == "left":
        move_axis("pan", state["pan"] - 25)
        return
    if cmd == "right":
        move_axis("pan", state["pan"] + 25)
        return
    if cmd in ("pan", "tilt") and len(parts) == 2:
        try:
            move_axis(cmd, int(parts[1]))
        except ValueError:
            print("# 角度需要整数")
        return
    print("# 未知命令：%s" % line)
    help_text()


poll = uselect.poll()
poll.register(sys.stdin, uselect.POLLIN)


def read_line():
    if not poll.poll(0):
        return None
    return sys.stdin.readline().strip()


def boot():
    print("# POG 桌面半身 · Wokwi 固件仿真")
    help_text()
    center("boot")
    nod()
    center("boot_settle")


boot()

while True:
    line = read_line()
    if line:
        handle(line)
        continue
    if ticks_diff(ticks_ms(), last_cmd) > IDLE_CENTER_MS and (state["pan"] or state["tilt"]):
        center("idle_timeout")
    sleep_ms(20)
