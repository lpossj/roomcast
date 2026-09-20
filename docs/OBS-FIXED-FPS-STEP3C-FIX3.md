# Roomcast OBS Fixed-FPS Step 3C Fix3

Fixes the clean-machine portability runner race where Windows PowerShell 5.1 could continue immediately after launching Electron (a GUI executable), causing the temporary OBS Virtual Camera registration to be removed before OBS initialized.

Changes:
- Launches Electron with `Start-Process -Wait -PassThru -NoNewWindow`.
- Cleanup runs only after the Electron process exits.
- Adds a generated-runner runtime self-test that sleeps ~800 ms and exits with code 37; the builder refuses to produce the portability ZIP unless both waiting and exit-code capture work.
- Keeps the previous PowerShell parser and missing-registry-key runtime gates.
- Does not modify Roomcast P2P/VDO/TURN/ICE/server/application source.

Expected builder gates:
- Windows PowerShell parser: PASS
- Registry missing-key runtime self-test: PASS
- GUI-process wait runtime self-test: PASS
