# EasyPlate agent guide

Use this file when an AI agent needs to launch or operate EasyPlate. See
[README.md](README.md) for the full user guide.

## Requirements and preflight

| Task | Required environment |
| --- | --- |
| Run via `start.sh` on macOS/Linux | Python 3.10+ as `python3` or `EASYPLATE_PYTHON`, Bash, and a current browser with JavaScript enabled |
| Run source on Windows | Python 3.10+ as `python` (or through `py -3`) and a current browser with JavaScript enabled |
| Clone the repository | Git, unless the project folder is already available |

The browser executes `app.js` and `xlsx.js` for the interactive app, so JavaScript must be
enabled there. It has no separate JavaScript installation step. The server
uses Python's standard library; there are no `pip` or npm dependencies, and
Node.js is not a runtime requirement.

Before running `start.sh` on macOS/Linux, check the commands and Python
version from the repository root:

```bash
command -v bash
python_bin="${EASYPLATE_PYTHON:-python3}"
command -v "$python_bin"
"$python_bin" -c 'import sys; print(sys.version.split()[0]); sys.exit(0 if sys.version_info >= (3, 10) else 1)'
```

Before starting on Windows, run this from PowerShell in the repository root:

```powershell
python --version
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"
```

Confirm that a local browser with JavaScript enabled is available, or that the
agent has browser automation on this computer. See [README.md](README.md) for
macOS, Linux, and Windows setup examples.

The server binds only to `127.0.0.1`, on port 8765 by default. The browser
must run on the same computer unless the user supplies a separate connection
method.

## Start and stop

On macOS/Linux, run `bash start.sh` from the repository root. It starts the
server and asks the default browser to open `http://127.0.0.1:8765`. On
Windows, run `python server.py` from PowerShell; it opens the default browser
too. If the browser does not open, enter the printed URL manually. Keep the
terminal running and press `Ctrl+C` to stop it. Use
`bash start.sh --port 8766` or `python server.py --port 8766` when the
default port is in use. If several Python versions are installed on
macOS/Linux, set `EASYPLATE_PYTHON` to the desired Python 3.10+ executable
before running `start.sh`.

For a headless agent with browser automation, run
`python3 server.py --no-browser` on macOS/Linux or
`python server.py --no-browser` on Windows in one terminal, then point the
browser at `http://127.0.0.1:8765`. The server only serves the page and
assets; there is no plate-management HTTP API. A shell HTTP request alone
cannot create plates or trigger exports.

## Use the browser app

For an authorized Linux/macOS update, stop the server and run
`bash start.sh update --check` followed by `bash start.sh update` from a source
folder, or `easyplate update` for an installed Homebrew command. The updater
uses the latest stable GitHub release, protects local source changes, and
keeps unrelated files. Restart the app afterward using the same port.
Use `easyplate --version` or `bash start.sh --version` to check the version.
Do not use Git reset or discard user edits to bypass an updater refusal.
Older installations need one manual Git/Homebrew update to obtain this command.
Pip wheels and native installers use their original installation method for
updates; Microsoft Store handles Windows Store updates.

1. Check whether the browser already has a project. EasyPlate autosaves to
   that browser's local storage; use a fresh browser profile for an isolated
   run. Do not reset an existing project unless the user asked for that.
2. Create plates with **New plate**, or import CSV/TSV/XLSX through the browser.
   For XLSX, choose a worksheet and whether to add plates, replace the project,
   or paste into the current plate. Well data restores complete annotations;
   new layout sheets support edited displayed values.
   Text input allows only English letters, numbers, `_`, and `-`; other
   characters become `_` with an **invalid input** warning.
3. Review the plate preview and any missing or duplicate well ID warning.
4. Use **Lock selected** in Layout Preview to protect selected wells from edits,
   and **Unlock selected** to make them editable again. Locked wells are saved
   in project JSON; bulk actions skip them or require unlocking first.
   **Lock** beside a feature protects that feature across every well and plate.
   Use **Unlock** before changing it. Feature locks persist in JSON and new XLSX
   exports. Do not bypass them through import or project replacement.
   **Copy wells** and **Paste wells** transfer metadata within or between plates;
   destination IDs stay intact unless **Include well IDs** is checked.
   For Excel ranges, choose **Paste table into**, focus the starting well, and
   paste tab-separated rows/columns with Ctrl/Cmd+V.
5. Use **Save project** for a reusable JSON copy. **Export CSV**,
   **Export plate PNG**, and **Export layout XLSX** download files through the
   browser. The XLSX has editable plate layouts and a Well data sheet; reimport
   the edited worksheet through **Import XLSX** to apply changes. **Save PDF** opens
   the browser print flow, where the PDF destination must be selected.

Downloads follow the browser's settings. Browser local storage and downloaded
files are separate from the Git repository.

## Data and exports

Use invented or anonymized data in examples. Keep real sample metadata,
downloaded project JSON, and exports out of Git.
