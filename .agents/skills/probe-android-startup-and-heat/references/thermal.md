# Thermal control

Coordinate a fixed hands-off window with the phone owner before a controlled run. Record brightness,
refresh rate, connection, battery level/temperature, charging state and thermal status. A warm or
throttled baseline can diagnose power but is unsuitable for cold performance acceptance.

A useful short protocol is 20s home-screen idle, 70s active game, 90s force-stopped cooldown, sampled
every 10s. This is an example, not a universal thermal steady-state duration. Record each transition
and use the same screen conditions. Do not screen-record the power control. Use separate video only
for UI ordering. Sampling itself costs power, so hold its cadence constant across arms.

Use supported adb reads such as dumpsys battery, dumpsys thermalservice, battery current_now and
voltage_now where readable. Preserve command exit codes and units; sensor availability and current
sign vary by device. For confirmed negative discharging current in microamps and voltage in
microvolts, device watts = -current * voltage / 1e12. Verify the discharge convention from battery
state rather than universally applying an absolute value. Missing sensors remain unavailable.
Do not change permissions to expose protected sensors.

Sample app and WebView CPU, with top's first refresh treated cautiously; 100% commonly means one
core. Store process information privately and publish only relevant aggregate metrics. A configured
240 FPS cap says nothing about achieved FPS. Report measured frame rate and the coverage of GPU
and CPU timers; a small GPU timestamp may exclude other work.

Compare power distributions by phase and temperature evolution. Battery temperature lags heat and
may not follow a brief power spike. A return to idle power after force-stop establishes active app
cost, not whether backgrounding suspends it. Probe background separately if that is the question.

Useful diagnostic controls, when within scope: cap to 30 FPS, lower UI publish frequency, temporarily
ablate UI updates, profile steady-state JS/native activity. Keep these separate from approved game
quality changes and restore the original source afterward. Compare screenshots/movement when the
control could affect behavior. Avoid attributing heat to another app from a single process snapshot.
