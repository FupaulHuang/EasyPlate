# EasyPlate

EasyPlate is a local browser tool for planning sample plate layouts, assigning well metadata, and exporting plate annotations and maps. It serves only on `127.0.0.1`; imported table contents are processed on this computer.

## Requirements

- Python 3.10 or newer (`python3` on macOS/Linux or `py -3` on Windows).
- A current browser with JavaScript enabled, such as Safari, Edge, Chrome, or
  Firefox.
- Bash only for the `start.sh` convenience launcher on macOS/Linux. Windows
  can run `server.py` directly from PowerShell.

The browser runs `app.js` for plate editing, import, and export; no separate
JavaScript installation is needed. The local server uses only Python's standard
library. It does not need `pip`, a virtual environment, Node.js, or npm to run.
Git is needed only if you clone the repository rather than download it as a ZIP
file.

## Quick setup

### macOS

Check your Python version with `python3 --version`. If it is missing or older
than 3.10, install a current Python with [Homebrew](https://brew.sh/):

```bash
brew install python
```

You can also use the [official Python macOS installer](https://docs.python.org/3/using/mac.html).

### Install with Homebrew on macOS

To install the packaged command, use the separate
[EasyPlate Homebrew tap](https://github.com/FupaulHuang/homebrew-easyplate):

```bash
brew tap FupaulHuang/easyplate
brew trust --formula FupaulHuang/easyplate/easyplate
brew install FupaulHuang/easyplate/easyplate
easyplate
```

Homebrew installs the Python version required by this package. To stop
EasyPlate, press `Ctrl+C` in its terminal. To uninstall the package:

```bash
brew uninstall FupaulHuang/easyplate/easyplate
```

To also remove the formula's trust and the tap:

```bash
brew untrust --formula FupaulHuang/easyplate/easyplate
brew untap FupaulHuang/easyplate
```

### Ubuntu 22.04+ or Debian 12+ Linux

On a Linux desktop with a current browser, install the command-line tools if
they are missing:

```bash
sudo apt update
sudo apt install python3 bash git
python3 --version
```

For another Linux distribution, use its package manager to install Python
3.10+ and Bash. Check the result with `python3 --version`.

### Clone and run on macOS or Linux

After Python is installed on macOS or Linux:

```bash
git clone https://github.com/FupaulHuang/EasyPlate.git
cd EasyPlate
bash start.sh
```

### Windows (PowerShell)

Install Python 3.10 or newer using the [official Python Windows instructions](https://docs.python.org/3/using/windows.html).
Then run these commands in PowerShell (`git clone` requires Git; you can also
download and extract the repository ZIP):

```powershell
py -3 --version
git clone https://github.com/FupaulHuang/EasyPlate.git
cd EasyPlate
py -3 server.py
```

Open `http://127.0.0.1:8765` in your browser. Keep PowerShell open while using
EasyPlate; press `Ctrl+C` to stop the server. If `py` is unavailable but
`python --version` reports Python 3.10+, use `python server.py` instead.

## Start from an existing project folder

On macOS or Linux, run:

```bash
bash start.sh
```

On Windows, run `py -3 server.py` from PowerShell instead. `start.sh` asks
Python's default browser handler to open the page on macOS/Linux. Keep the
terminal open while using EasyPlate; press `Ctrl+C` there to stop it. No
internet connection is needed after setup.

To choose another port, run `bash start.sh --port 8766` on macOS/Linux or
`py -3 server.py --port 8766` on Windows, then open
`http://127.0.0.1:8766`. The installed `easyplate` command also accepts
`--port 8766`.

If the browser does not open automatically, open `http://127.0.0.1:8765` on
the same computer. `127.0.0.1` refers to that computer only.

## Create and edit plates

- Use **New plate** or **Duplicate** to add a plate. Set its label, group, dimensions, sample index, and source sample in **Plate details**.
- Use **Create multiple** to add several blank plates at once with generated labels. **Delete all except first** keeps the first plate unchanged and removes the others. **Reset project to defaults** restores one blank plate and the default fields. **Apply this plate's layout and metadata to all plates** copies its well layout and values to the other plates while retaining their labels and source details.
- New plates use 8 rows × 12 columns by default. The editor supports 1–40 rows and 1–48 columns.
- Automatic well ID fill is enabled by default and assigns an ID to every well, starting with `well_dt_1`. Turning **Automatically fill all well IDs** off clears IDs from every well; turning it on fills missing IDs across the project. Select wells and use **Generate IDs for selected wells** to generate IDs using the configured prefix and start number, skipping IDs already in use. **Regenerate all plate IDs** replaces IDs across the project after confirmation. Choose whether numbering restarts or continues across plates. Well ID is always present in **Well details** for manual editing.
- **Well Details** sits between Plate Setup and Layout Preview. **Clear selected values** clears the selected wells' ID, barcode, occupancy, and metadata. If automatic fill is on, IDs are assigned again to those wells.
- **Invert selection** toggles every well in the visible window. In windowed view, selections in other windows are preserved.
- **Select all wells** selects every well on the current plate, including wells in other windows. When all wells are selected, the button becomes **Deselect all wells**.
- Select a well or drag over a rectangular region. Shift-click adds or removes individual wells. Edit the well ID and active metadata fields in **Well details**. **Clear values** beside a field clears only that feature across every well; **Remove** deletes an optional feature and its values. **Add field** creates a new optional metadata field. Clearing Well ID values turns Automatic fill off so IDs stay cleared.
- A barcode or assigned metadata marks a well occupied; a generated well ID alone does not. Use the occupancy checkbox to mark planned wells occupied or clear metadata-only occupancy.
- Choose one or more fields under **Color and label by** to color and label by a single field or a combination. Well cells and exported layout figures show values without repeating feature names; the two-second hover card shows field names with their values for every active feature.
- Use **Show Well ID** in Layout Preview to toggle the ID caption beneath each well; PNG and PDF layouts follow this setting. Hover details continue to include the Well ID.
- New projects start with **Cell line** and **Species** as the selected display features. Replicate and Test are not default fields. Barcode can be added when needed. **Select all** includes every feature and toggles to **Deselect all**; clicking again clears the display selection.
- Adjust **Well size** (40–160 px) and **Font size** (8–30 px) under **Preview size** using either the sliders or exact-number inputs. Turn on **Show large plates in windows** to page through row/column sections; choose how many rows and columns each window shows. PNG export uses the current window, and PDF export creates a page for each window.
- The interface and default plate label font are scaled 1.5× larger; existing default font settings are upgraded while user-adjusted larger sizes are retained.
- Paste spreadsheet cells directly into a focused well. A plain grid fills the selected feature; a table with headers such as `well_id`, `cell_line`, `species`, `dose`, and `time` fills matching metadata fields. `well_name_label` is generated at export and is not an editable feature.

## Import

- **Import CSV / TSV** reads a delimited metadata table. Headers such as `plate_id`, `plate_position`, `well_id`, `barcode`, `cell_line`, `species`, `compound`, `dose`, `time`, `x`, and `y` are recognized; `compound` maps to **Treatment**. Tables grouped by `plate_id` become separate plates. A supplied `well_name_label` is ignored because the name is generated from active metadata.
- You can also copy cells from Excel and paste directly into a focused plate cell.

## Export and project saving

- **Export CSV** downloads `plate_layout_annotations.csv`, with one row per physical position (including empty positions), the reference annotation columns, and every active feature that has at least one value, whether or not that feature is displayed in the figure. It also generates `well_name_label` by joining each well's nonempty active metadata values with `_`, excluding Well ID. Optional feature columns and `group`, `sample_index`, or `source_sample` are omitted individually when empty (`None`/`NA`) across the whole project; missing cells in retained columns are exported blank. The current display selection does not affect CSV columns.
- **Export plate PNG** downloads a high-resolution image of the current plate window with selected feature text wrapped in each well.
- **Save PDF** opens a print-ready view. Large plates are paged into manageable row/column sections; when many features are selected, the PDF splits them into feature groups so labels and values remain visible. In the browser print dialog, choose **Save as PDF**.
- **Save project** downloads a JSON copy. **Open project** restores one. The current project also autosaves in browser storage for this local address.

The CSV export reports repeated or missing well IDs before downloading and lets you decide whether to continue. The generated default ID order runs down rows in each column, matching the supplied workbook layout.

## Project files

`index.html`, `styles.css`, and `app.js` are the browser interface. `server.py`
serves them on this computer; `start.sh` launches the server and opens a
browser on macOS/Linux. See [AGENTS.md](AGENTS.md) for AI agent run instructions.
Keep real sample metadata and exported projects out of the repository; use
invented or anonymized examples instead.

## License

EasyPlate is released under the [MIT License](LICENSE).
