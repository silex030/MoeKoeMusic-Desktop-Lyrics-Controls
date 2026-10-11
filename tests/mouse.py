"""Move/click the real pointer in the task's own Xvfb display, not a user desktop."""
import ctypes
import ctypes.util
import json
import os
import sys
from pathlib import Path

state_path = Path(os.environ.get('MOEKOE_SERVICE_STATE', '/workspace/.moekoe-environment/runtime/services.json'))
owner_pid = json.loads(state_path.read_text())['electron']['pid']
display_name = None
for process in Path('/proc').iterdir():
    if not process.name.isdigit():
        continue
    try:
        fields = (process / 'stat').read_text().rsplit(')', 1)[1].split()
        if int(fields[1]) != owner_pid:
            continue
        argv = [part.decode() for part in (process / 'cmdline').read_bytes().split(b'\0') if part]
        if not argv or Path(argv[0]).name != 'Xvfb':
            continue
        display_name = argv[1]
        if '-auth' in argv:
            os.environ['XAUTHORITY'] = argv[argv.index('-auth') + 1]
        break
    except (OSError, ValueError, IndexError):
        continue
if not display_name:
    raise SystemExit('No Xvfb owned by the test service helper found; refusing to control another display')
os.environ['DISPLAY'] = display_name
x11 = ctypes.CDLL(ctypes.util.find_library('X11'))
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XWarpPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_int, ctypes.c_int]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
display = x11.XOpenDisplay(None)
if not display:
    raise SystemExit('Cannot access the owned test Xvfb display')
try:
    x11.XWarpPointer(display, 0, x11.XDefaultRootWindow(display), 0, 0, 0, 0, int(sys.argv[1]), int(sys.argv[2]))
    if len(sys.argv) > 3 and sys.argv[3] == 'click':
        xtest = ctypes.CDLL(ctypes.util.find_library('Xtst'))
        xtest.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        xtest.XTestFakeButtonEvent(display, 1, 1, 0)
        xtest.XTestFakeButtonEvent(display, 1, 0, 0)
    x11.XFlush(display)
finally:
    x11.XCloseDisplay(display)
