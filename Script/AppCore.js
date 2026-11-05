/**
 * GeoCodile Phase 1 Core Engine
 * Bridges header.js ('geocodile:action'), workspace [data-action] buttons,
 * FastAPI file ingestion (/api/data/import), R/Pandas DataGrid, and DOM Logger.
 */
(function () {
  "use strict";

  const APP_STATE = {
    datasetName: "Untitled",
    columns: [],
    rows: [],
    meta: {},
    committed: false,
    activeUploadController: null
  };
  const DATASETS = [];
  let activeDatasetIndex = -1;

  const DEFAULT_SYMBOLS = [
    "circle",
    "square",
    "triangle-up",
    "diamond",
    "cross",
    "x",
    "pentagon",
    "star"
  ];

  const DEFAULT_PALETTE = [
    "#2563eb",
    "#dc2626",
    "#16a34a",
    "#d97706",
    "#9333ea",
    "#0891b2",
    "#db2777",
    "#4f46e5"
  ];

  const GROUP_CANDIDATES = ["Group", "Rock_Type", "Lithology", "Unit", "Suite", "Category", "Type"];
  const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
  const SNAPSHOT_DEBOUNCE_MS = 300;

  let plotPlaceholderHTML = null;
  let snapshotTimer = null;
  let gridSearchTerm = "";
  let advancedFilters = [];
  const selectedCells = new Set();
  let lastCellKey = null;

  const isSymbolCol = (name) => String(name).toLowerCase() === "symbol";
  const isColorCol = (name) => String(name).toLowerCase() === "color";

  /* ========================================================================
     1. XSS-Safe DOM Logger (Bound to #log-output-stream in index.html)
     ======================================================================== */
  const Logger = {
    maxEntries: 500,
    counts: { total: 0, info: 0, warn: 0, error: 0 },

    log(level, category, message) {
      const stream = document.getElementById("log-output-stream");
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const timeStr = `${now.getFullYear()}/${now.toLocaleString("en", { month: "short" }).toLowerCase()}/${pad(now.getDate())}  ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

      this.counts.total += 1;
      if (level === "INFO" || level === "OK") this.counts.info += 1;
      if (level === "WARN") this.counts.warn += 1;
      if (level === "ERROR") this.counts.error += 1;

      this._updateCounters();

      if (!stream) return;

      const entry = document.createElement("div");
      entry.className = `log-entry log-${level.toLowerCase()}`;
      entry.dataset.logLevel = level.toLowerCase();

      const tsSpan = document.createElement("span");
      tsSpan.className = "log-timestamp";
      tsSpan.textContent = `[${timeStr}]`;

      const lvlSpan = document.createElement("span");
      lvlSpan.className = `log-level level-${level.toLowerCase()}`;
      lvlSpan.textContent = level.toUpperCase();

      const catSpan = document.createElement("span");
      catSpan.className = "log-category";
      catSpan.textContent = `[${category}]`;

      const msgSpan = document.createElement("span");
      msgSpan.className = "log-message";
      msgSpan.textContent = `[${this.counts.total}][${timeStr}]: ${String(message || "")}`;

      entry.append(tsSpan, lvlSpan, catSpan, msgSpan);
      stream.appendChild(entry);

      while (stream.children.length > this.maxEntries) {
        stream.removeChild(stream.firstElementChild);
      }

      stream.scrollTop = stream.scrollHeight;
    },

    _updateCounters() {
      const setTxt = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = String(val);
      };
      setTxt("log-count-total", this.counts.total);
      setTxt("log-count-info", this.counts.info);
      setTxt("log-count-warn", this.counts.warn);
      setTxt("log-count-error", this.counts.error);
      setTxt("log-badge-count", this.counts.error + this.counts.warn);
    },

    clear() {
      const stream = document.getElementById("log-output-stream");
      if (stream) stream.textContent = "";
      this.counts = { total: 0, info: 0, warn: 0, error: 0 };
      this._updateCounters();
      this.log("INFO", "SYSTEM", "Console log history cleared.");
    }
  };

  /* ========================================================================
     2. Workspace View Switcher (Sheet / Plot / Logs)
     ======================================================================== */
  function switchWorkspaceView(targetView) {
    const viewMap = {
      sheet: { panel: "viewport-sheet", tab: "tab-btn-sheet" },
      plot: { panel: "viewport-plot", tab: "tab-btn-plot" },
      logs: { panel: "viewport-logs", tab: "tab-btn-logs" }
    };

    if (!viewMap[targetView]) return;

    Object.keys(viewMap).forEach((key) => {
      const isTarget = key === targetView;
      const panelEl = document.getElementById(viewMap[key].panel);
      const tabEl = document.getElementById(viewMap[key].tab);

      if (panelEl) {
        panelEl.classList.toggle("is-active", isTarget);
        panelEl.hidden = !isTarget;
        panelEl.style.display = isTarget ? "" : "none";
      }

      if (tabEl) {
        tabEl.classList.toggle("is-active", isTarget);
        tabEl.setAttribute("aria-selected", isTarget ? "true" : "false");
      }
    });

    document.querySelectorAll(".options-context-container").forEach((panel) => {
      const isTarget = panel.id === `options-panel-${targetView}`;
      panel.classList.toggle("is-active", isTarget);
      panel.classList.toggle("hidden", !isTarget);
      panel.hidden = !isTarget;
    });

    if (targetView === "sheet") {
      const emptyState = document.getElementById("sheet-empty-state");
      const gridContainer = document.getElementById("sheet-datagrid-state");
      const hasData = APP_STATE.columns.length > 0;
      if (emptyState) emptyState.hidden = hasData;
      if (gridContainer) gridContainer.hidden = !hasData;
    }
  }

  /* ========================================================================
     3. Smart Auto-Generation of Symbol & Color Columns
     ======================================================================== */
  function enrichWithSymbolAndColor(columns, rows, existingMeta) {
    const cols = Array.isArray(columns) ? [...columns] : [];
    const dataRows = Array.isArray(rows) ? rows.map((r) => ({ ...r })) : [];
    const meta = existingMeta && typeof existingMeta === "object" ? { ...existingMeta } : {};

    cols.forEach((col) => {
      if (!meta[col]) {
        const isNum = dataRows.some((r) => {
          const v = r[col];
          return v !== null && v !== undefined && v !== "" && !Number.isNaN(Number(v));
        });
        meta[col] = isNum ? "<dbl>" : "<chr>";
      }
    });

    const groupCol = cols.find((c) =>
      GROUP_CANDIDATES.some((cand) => cand.toLowerCase() === c.toLowerCase())
    );

    // Reuse an existing Symbol/Color column regardless of its casing
    // (writing to a hard-coded "Symbol" key would create a hidden, unrendered field).
    const symbolKey = cols.find(isSymbolCol);
    const colorKey = cols.find(isColorCol);

    const groupMap = new Map();
    let groupCounter = 0;

    dataRows.forEach((row, idx) => {
      let styleIdx;
      const groupVal = groupCol ? row[groupCol] : undefined;

      if (groupVal !== null && groupVal !== undefined && groupVal !== "") {
        const key = String(groupVal).trim();
        if (!groupMap.has(key)) groupMap.set(key, groupCounter++);
        styleIdx = groupMap.get(key);
      } else {
        styleIdx = idx % DEFAULT_SYMBOLS.length;
      }

      if (symbolKey && !row[symbolKey]) row[symbolKey] = DEFAULT_SYMBOLS[styleIdx % DEFAULT_SYMBOLS.length];
      if (colorKey && !row[colorKey]) row[colorKey] = DEFAULT_PALETTE[styleIdx % DEFAULT_PALETTE.length];
    });

    return { columns: cols, rows: dataRows, meta };
  }

  /* ========================================================================
     4. DataGrid Renderer & Sidebar Tools (Transpose / Reverse Columns)
     ======================================================================== */
  function ensureSidebarLayout() {
    const wrapper = document.getElementById("datagrid-scroll-viewport");
    if (!wrapper || document.getElementById("datagrid-sidebar-tools")) return;

    const parent = wrapper.parentElement;
    if (!parent) return;

    const layoutBox = document.createElement("div");
    layoutBox.className = "datagrid-workspace-layout";

    const sidebar = document.createElement("aside");
    sidebar.id = "datagrid-sidebar-tools";
    sidebar.className = "datagrid-sidebar-tools";

    parent.insertBefore(layoutBox, wrapper);
    layoutBox.append(wrapper);
  }

  function renderDataGrid() {
    ensureSidebarLayout();

    const onboarding = document.getElementById("sheet-empty-state");
    const wrapper = document.getElementById("datagrid-scroll-viewport");
    const thead = document.querySelector("#geochem-dataframe thead");
    const tbody = document.getElementById("df-body-rows");
    const table = document.getElementById("geochem-dataframe");

    if (!thead || !tbody || !table) return;

    if (APP_STATE.columns.length === 0) {
      if (onboarding) onboarding.hidden = false;
      if (wrapper) wrapper.hidden = true;
      thead.textContent = "";
      tbody.textContent = "";
      return;
    }

    if (onboarding) onboarding.hidden = true;
    if (wrapper) wrapper.hidden = false;

    table.classList.toggle("is-committed", APP_STATE.committed);

    thead.textContent = "";
    tbody.textContent = "";

    const trHead = document.createElement("tr");
    const thIdx = document.createElement("th");
    thIdx.className = "df-cell-index";
    thIdx.textContent = "#";
    trHead.appendChild(thIdx);

    APP_STATE.columns.forEach((colName) => {
      const th = document.createElement("th");
      const titleDiv = document.createElement("div");
      titleDiv.textContent = colName;

      th.dataset.columnName = colName;
      th.addEventListener("click", () => {
        selectedCells.clear();
        APP_STATE.rows.forEach((_, rowIndex) => selectedCells.add(`${rowIndex}:${colName}`));
        document.querySelectorAll(".dataframe-table td[data-cell-key]").forEach((cell) => cell.classList.toggle("is-selected", selectedCells.has(cell.dataset.cellKey)));
      });
      th.append(titleDiv);
      trHead.appendChild(th);
    });
    thead.appendChild(trHead);

    const fragment = document.createDocumentFragment();

    const visibleRows = APP_STATE.rows
      .map((rowObj, rowIdx) => ({ rowObj, rowIdx }))
      .filter(({ rowObj }) => {
        if (!gridSearchTerm) return true;
        return APP_STATE.columns.some((colName) =>
          String(rowObj[colName] ?? "").toLowerCase().includes(gridSearchTerm)
        );
      })
      .filter(({ rowObj }) => advancedFilters.every((rule) => {
        if (!rule.column || rule.value === "") return true;
        const raw = rowObj[rule.column];
        const left = Number(raw);
        const right = Number(rule.value);
        if (Number.isFinite(left) && Number.isFinite(right)) {
          return ({">": left > right, ">=": left >= right, "<": left < right, "<=": left <= right, "=": left === right, "!=": left !== right})[rule.operator];
        }
        const a = String(raw ?? "").toLowerCase();
        const b = String(rule.value).toLowerCase();
        return rule.operator === "!=" ? a !== b : rule.operator === "=" ? a === b : a.includes(b);
      }));

    visibleRows.forEach(({ rowObj, rowIdx }) => {
      const tr = document.createElement("tr");

      const tdIdx = document.createElement("td");
      tdIdx.className = "df-cell-index";
      tdIdx.textContent = String(rowIdx + 1);
      tdIdx.addEventListener("click", () => {
        selectedCells.clear();
        APP_STATE.columns.forEach((column) => selectedCells.add(`${rowIdx}:${column}`));
        document.querySelectorAll(".dataframe-table td[data-cell-key]").forEach((cell) => cell.classList.toggle("is-selected", selectedCells.has(cell.dataset.cellKey)));
      });
      tr.appendChild(tdIdx);

      APP_STATE.columns.forEach((colName) => {
        const td = document.createElement("td");
        const cellKey = `${rowIdx}:${colName}`;
        td.dataset.cellKey = cellKey;
        td.addEventListener("click", (event) => {
          if (event.shiftKey && lastCellKey) {
            selectedCells.add(lastCellKey);
          } else if (!event.ctrlKey && !event.metaKey) {
            selectedCells.clear();
          }
          selectedCells.add(cellKey);
          lastCellKey = cellKey;
          document.querySelectorAll(".dataframe-table td.is-selected").forEach((cell) => cell.classList.remove("is-selected"));
          selectedCells.forEach((key) => document.querySelector(`[data-cell-key="${CSS.escape(key)}"]`)?.classList.add("is-selected"));
        });
        const val = rowObj[colName];

        if (isSymbolCol(colName)) {
          const select = document.createElement("select");
          select.className = "df-select-symbol";
          select.disabled = APP_STATE.committed;

          const current = val === null || val === undefined ? "" : String(val);
          const options = [...DEFAULT_SYMBOLS];
          // Keep unknown values from the file visible instead of silently showing the first option.
          if (current && !options.includes(current)) options.unshift(current);
          if (!current) options.unshift("");

          options.forEach((sym) => {
            const opt = document.createElement("option");
            opt.value = sym;
            opt.textContent = sym || "NA";
            opt.selected = sym === current;
            select.appendChild(opt);
          });

          select.addEventListener("change", (e) => {
            const newVal = e.target.value || null;
            APP_STATE.rows[rowIdx][colName] = newVal;
            Logger.log("INFO", "EDIT", `Row ${rowIdx + 1} [${colName}] updated to '${newVal ?? "NA"}'.`);
            triggerAutoSnapshot();
          });
          td.appendChild(select);
        } else if (isColorCol(colName)) {
          const colorWrap = document.createElement("div");
          colorWrap.className = "df-color-editor";
          const colorInput = document.createElement("input");
          colorInput.type = "color"; colorInput.className = "df-input-color"; colorInput.disabled = APP_STATE.committed;
          colorInput.value = typeof val === "string" && HEX_COLOR_RE.test(val) ? val : "#2563eb";
          const hexInput = document.createElement("input");
          hexInput.type = "text"; hexInput.className = "df-input-hex"; hexInput.placeholder = "#RRGGBB"; hexInput.value = colorInput.value; hexInput.disabled = APP_STATE.committed;
          const updateColor = (next) => {
            if (!HEX_COLOR_RE.test(next)) return;
            APP_STATE.rows[rowIdx][colName] = next; colorInput.value = next; hexInput.value = next;
            Logger.log("INFO", "EDIT", `Row ${rowIdx + 1} [${colName}] updated to '${next}'.`);
            triggerAutoSnapshot();
          };
          colorInput.addEventListener("input", (e) => updateColor(e.target.value));
          hexInput.addEventListener("change", (e) => updateColor(e.target.value.trim()));
          colorWrap.append(colorInput, hexInput); td.appendChild(colorWrap);
        } else {
          const isNull = val === null || val === undefined || val === "";
          td.textContent = isNull ? "NA" : String(val);
          td.classList.toggle("df-cell-na", isNull);
          td.classList.toggle(
            "df-cell-numeric",
            !isNull && APP_STATE.meta[colName] === "<dbl>" && typeof val === "number"
          );

          if (!APP_STATE.committed) {
            td.contentEditable = "true";
            td.classList.add("df-cell-editable");

            // Enter commits the edit instead of inserting a line break into the cell.
            td.addEventListener("keydown", (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                td.blur();
              }
            });

            td.addEventListener("blur", () => {
              const rawText = td.textContent.trim();
              const prevVal = APP_STATE.rows[rowIdx][colName];
              const prevStr = prevVal === null || prevVal === undefined ? "NA" : String(prevVal);

              if (rawText === prevStr) return;

              let parsed = rawText;
              if (rawText === "" || rawText.toUpperCase() === "NA") {
                parsed = null;
              } else if (APP_STATE.meta[colName] === "<dbl>") {
                // Only coerce to number for numeric columns; "007" in a text column must stay "007".
                const numCandidate = Number(rawText);
                if (Number.isFinite(numCandidate)) parsed = numCandidate;
              }

              APP_STATE.rows[rowIdx][colName] = parsed;

              const shown = parsed === null ? "NA" : String(parsed);
              td.textContent = shown;
              td.classList.toggle("df-cell-na", parsed === null);
              td.classList.toggle("df-cell-numeric", typeof parsed === "number");

              Logger.log(
                "INFO",
                "EDIT",
                `Cell (Row ${rowIdx + 1}, Col '${colName}') changed from '${prevStr}' to '${shown}'.`
              );
              triggerAutoSnapshot();
            });
          }
        }

        tr.appendChild(td);
      });

      fragment.appendChild(tr);
    });

    tbody.appendChild(fragment);
    tbody.addEventListener("contextmenu", (event) => {
      const cell = event.target.closest("td[data-cell-key]");
      if (!cell) return;
      event.preventDefault();
      const menu = document.createElement("div");
      menu.className = "grid-context-menu";
      menu.innerHTML = '<button data-command="copy">Copy</button><button data-command="paste">Paste</button><button data-command="clear">Clear cell contents</button><button data-command="delete-row">Delete row</button>';
      menu.style.left = `${event.clientX}px`;
      menu.style.top = `${event.clientY}px`;
      document.body.appendChild(menu);
      const close = () => menu.remove();
      menu.addEventListener("click", async (clickEvent) => {
        const command = clickEvent.target.dataset.command;
        const [rowIndex, column] = cell.dataset.cellKey.split(":");
        if (command === "copy") await navigator.clipboard?.writeText(String(APP_STATE.rows[Number(rowIndex)][column] ?? ""));
        if (command === "paste") APP_STATE.rows[Number(rowIndex)][column] = await navigator.clipboard?.readText();
        if (command === "clear") APP_STATE.rows[Number(rowIndex)][column] = null;
        if (command === "delete-row") APP_STATE.rows.splice(Number(rowIndex), 1);
        if (command !== "copy") { renderDataGrid(); triggerAutoSnapshot(); Logger.log("INFO", "EDIT", `Grid action: ${command}.`); }
        close();
      });
      setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
    }, { once: true });
    updateWorkspaceMetaUI();
  }

  function updateWorkspaceMetaUI() {
    const setTxt = (id, txt) => {
      const el = document.getElementById(id);
      if (el) el.textContent = txt;
    };

    const rowCount = APP_STATE.rows.length;
    const colCount = APP_STATE.columns.length;
    const hasData = colCount > 0;

    setTxt("lbl-dataset-name", APP_STATE.datasetName);
    setTxt("lbl-grid-dimensions", `${rowCount} rows × ${colCount} cols`);
    setTxt("badge-sheet-count", String(rowCount));
    setTxt("status-dataset-counter", `${rowCount} Samples · ${colCount} Variables`);

    const lockStatus = document.getElementById("dataset-lock-status");
    if (lockStatus) {
      lockStatus.textContent = APP_STATE.committed ? "Data Confirmed" : hasData ? "Draft Dataset" : "No Active Dataset";
      lockStatus.classList.toggle("status-committed", APP_STATE.committed);
      lockStatus.classList.toggle("status-uncommitted", !APP_STATE.committed);
    }

    let naCount = 0;
    APP_STATE.rows.forEach((r) => {
      APP_STATE.columns.forEach((c) => {
        if (r[c] === null || r[c] === undefined || r[c] === "") naCount += 1;
      });
    });
    setTxt("df-stat-na", String(naCount));

    const pill = document.getElementById("sheet-validation-status");
    if (pill) {
      pill.textContent = APP_STATE.committed ? "Data confirmed and registered." : hasData ? "Review the imported values before confirming." : "No data loaded.";
    }

    const btnIds = [
      "btn-add-row",
      "btn-add-col",
      "btn-clean-na",
      "btn-validate-schema",
      "btn-clear-sheet",
      "btn-commit-dataframe",
      "btn-edit-dataframe",
      "btn-sidebar-validate",
      "btn-sidebar-edit",
      "btn-sidebar-confirm",
      "btn-sidebar-clear",
      "btn-sidebar-symbol",
      "btn-sidebar-color",
      "btn-sidebar-transpose",
      "btn-sidebar-reverse"
    ];

    btnIds.forEach((id) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      if (id === "btn-clear-sheet" || id === "btn-sidebar-clear") {
        btn.disabled = !hasData;
      } else if (id === "btn-edit-dataframe") {
        btn.disabled = !hasData || !APP_STATE.committed;
      } else if (id === "btn-sidebar-edit") {
        btn.disabled = !hasData || !APP_STATE.committed;
      } else {
        btn.disabled = !hasData || APP_STATE.committed;
      }
    });
  }

  function renderDatasetTabs() {
    const strip = document.getElementById("sheet-dataset-tabs");
    if (!strip) return;
    strip.textContent = "";
    DATASETS.forEach((dataset, index) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `sheet-dataset-tab${index === activeDatasetIndex ? " is-active" : ""}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(index === activeDatasetIndex));
      tab.textContent = dataset.datasetName;
      tab.title = `${dataset.rows.length} rows × ${dataset.columns.length} columns`;
      tab.addEventListener("click", () => {
        const current = DATASETS[activeDatasetIndex];
        if (current) Object.assign(current, { datasetName: APP_STATE.datasetName, columns: APP_STATE.columns, rows: APP_STATE.rows, meta: APP_STATE.meta, committed: APP_STATE.committed });
        const selected = DATASETS[index];
        activeDatasetIndex = index;
        Object.assign(APP_STATE, { datasetName: selected.datasetName, columns: selected.columns, rows: selected.rows, meta: selected.meta, committed: selected.committed });
        renderDataGrid();
        updateWorkspaceMetaUI();
        Logger.log("INFO", "DATASET", `Switched to dataset '${selected.datasetName}'.`);
      });
      strip.appendChild(tab);
    });
  }

  function syncActiveDataset() {
    if (activeDatasetIndex < 0 || !DATASETS[activeDatasetIndex]) return;
    Object.assign(DATASETS[activeDatasetIndex], {
      datasetName: APP_STATE.datasetName, columns: APP_STATE.columns,
      rows: APP_STATE.rows, meta: APP_STATE.meta, committed: APP_STATE.committed
    });
  }

  /* ========================================================================
     5. Matrix Operations: Transpose & Reverse Columns
     ======================================================================== */
  function addStyleColumn(kind) {
    if (APP_STATE.committed) return;
    const isSymbol = kind === "symbol";
    const column = APP_STATE.columns.find(isSymbol ? isSymbolCol : isColorCol);
    if (column) {
      Logger.log("INFO", "STYLE", `${isSymbol ? "Symbol" : "Color"} column already exists.`);
      return;
    }
    const name = isSymbol ? "Symbol" : "Color";
    APP_STATE.columns.push(name);
    APP_STATE.meta[name] = isSymbol ? "symbol" : "color";
    APP_STATE.rows.forEach((row, index) => {
      row[name] = isSymbol ? DEFAULT_SYMBOLS[index % DEFAULT_SYMBOLS.length] : DEFAULT_PALETTE[index % DEFAULT_PALETTE.length];
    });
    syncActiveDataset();
    renderDataGrid();
    Logger.log("OK", "STYLE", `${name} column added.`);
    triggerAutoSnapshot();
  }

  function transposeDataGrid() {
    if (APP_STATE.committed || APP_STATE.columns.length === 0) return;

    const oldCols = APP_STATE.columns;
    const oldRows = APP_STATE.rows;

    const newCols = ["Attribute", ...oldRows.map((_, idx) => `Row_${idx + 1}`)];
    const newRows = oldCols.map((colName) => {
      const rowObj = { Attribute: colName };
      oldRows.forEach((r, idx) => {
        rowObj[`Row_${idx + 1}`] = r[colName];
      });
      return rowObj;
    });

    const newMeta = { Attribute: "<chr>" };
    oldRows.forEach((_, idx) => {
      newMeta[`Row_${idx + 1}`] = "<chr>";
    });

    APP_STATE.columns = newCols;
    APP_STATE.rows = newRows;
    APP_STATE.meta = newMeta;

    syncActiveDataset();
    renderDataGrid();
    Logger.log("INFO", "MATRIX", "Dataframe transposed (Rows <-> Columns).");
    triggerAutoSnapshot();
  }

  function reverseColumnsOrder() {
    if (APP_STATE.committed || APP_STATE.columns.length === 0) return;

    APP_STATE.columns = [...APP_STATE.columns].reverse();
    syncActiveDataset();
    renderDataGrid();
    Logger.log("INFO", "MATRIX", "Column order reversed (LTR <-> RTL).");
    triggerAutoSnapshot();
  }

  /* ========================================================================
     6. Commit & Plot Readiness Workflow
     ======================================================================== */
  function resetPlotReadiness() {
    const emptyState = document.getElementById("plot-empty-state");
    if (emptyState && plotPlaceholderHTML !== null) emptyState.innerHTML = plotPlaceholderHTML;

    const dot = document.getElementById("plot-ready-dot");
    if (dot) dot.style.backgroundColor = "";
  }

  function buildDatasetPayload(committed = APP_STATE.committed) {
    return {
      dataset_name: APP_STATE.datasetName,
      committed,
      columns: APP_STATE.columns,
      meta: APP_STATE.meta,
      rows: APP_STATE.rows
    };
  }

  function setValidationMessage(message, isError = false) {
    ["sheet-validation-status", "sheet-validation-message"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = message;
      el.classList.toggle("validation-error", isError);
      el.classList.toggle("validation-success", !isError && Boolean(message));
    });
  }

  async function validateDatasetOnServer() {
    if (APP_STATE.columns.length === 0) {
      setValidationMessage("Load data before validation.", true);
      return false;
    }

    try {
      const response = await fetch("/api/data/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildDatasetPayload(false))
      });
      const payload = await response.json();
      if (!response.ok || payload.success === false) {
        const message = errorMessage(payload.error) || errorMessage(payload.detail) || "Data validation failed.";
        setValidationMessage(message, true);
        Logger.log("ERROR", "VALIDATION", message);
        return false;
      }

      const warningText = Array.isArray(payload.warnings) && payload.warnings.length
        ? ` Validated with ${payload.warnings.length} warning(s).`
        : " Data is valid.";
      setValidationMessage(`Validation complete.${warningText}`);
      (payload.warnings || []).forEach((warning) => Logger.log("WARN", "VALIDATION", errorMessage(warning)));
      Logger.log("OK", "VALIDATION", `Validated ${APP_STATE.rows.length} rows and ${APP_STATE.columns.length} columns.`);
      return true;
    } catch (err) {
      setValidationMessage(`Validation service unavailable: ${err.message}`, true);
      Logger.log("ERROR", "VALIDATION", err.message);
      return false;
    }
  }

  async function commitDataframe() {
    if (APP_STATE.columns.length === 0 || APP_STATE.committed) return;

    const isValid = await validateDatasetOnServer();
    if (!isValid) return;

    try {
      const response = await fetch("/api/data/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildDatasetPayload(true))
      });
      const payload = await response.json();
      if (!response.ok || payload.success === false) {
        const message = errorMessage(payload.error) || errorMessage(payload.detail) || "Data confirmation failed.";
        setValidationMessage(message, true);
        Logger.log("ERROR", "COMMIT", message);
        return;
      }

      APP_STATE.committed = true;
      syncActiveDataset();
      renderDataGrid();

      const emptyState = document.getElementById("plot-empty-state");
      if (emptyState) {
        emptyState.textContent = "";
        const banner = document.createElement("div");
        banner.className = "plot-ready-banner";

        const h2 = document.createElement("h2");
        h2.textContent = "Everything is ready for plotting!";

        const p = document.createElement("p");
        p.textContent = `Dataset '${APP_STATE.datasetName}' (${APP_STATE.rows.length} samples) is confirmed and ready for plotting.`;

        banner.append(h2, p);
        emptyState.appendChild(banner);
      }

      const dot = document.getElementById("plot-ready-dot");
      if (dot) dot.style.backgroundColor = "#10b981";

      setValidationMessage("Data confirmed and registered for plotting.");
      Logger.log("OK", "COMMIT", `Dataset '${APP_STATE.datasetName}' confirmed and sent to backend.`);
      triggerAutoSnapshot();
    } catch (err) {
      setValidationMessage(`Confirmation service unavailable: ${err.message}`, true);
      Logger.log("ERROR", "COMMIT", err.message);
    }
  }

  function editDataframe() {
    if (APP_STATE.columns.length === 0) return;
    APP_STATE.committed = false;
    syncActiveDataset();
    renderDataGrid();
    setValidationMessage("Edit mode enabled. Confirm the data again when finished.");
    Logger.log("INFO", "EDIT", "Dataset unlocked for editing.");
    triggerAutoSnapshot();
  }

  /* ========================================================================
     7. File Upload & .nest Crash-Recovery Persistence
     ======================================================================== */
  let hiddenFileInput = null;

  function getOrCreateFileInput() {
    if (hiddenFileInput) return hiddenFileInput;

    hiddenFileInput = document.createElement("input");
    hiddenFileInput.type = "file";
    hiddenFileInput.accept = ".csv,.tsv,.txt,.xlsx,.xls,.xlsm,.ods,.pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff,.bmp,.clutch";
    hiddenFileInput.style.display = "none";
    document.body.appendChild(hiddenFileInput);

    hiddenFileInput.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      await uploadFileToServer(file);
      hiddenFileInput.value = "";
    });

    return hiddenFileInput;
  }

  function openPasteDialog() {
    if (document.getElementById("paste-data-dialog")) return;

    const overlay = document.createElement("div");
    overlay.id = "paste-data-dialog";
    overlay.className = "data-input-dialog-backdrop";

    const dialog = document.createElement("section");
    dialog.className = "data-input-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "paste-data-title");

    const title = document.createElement("h2");
    title.id = "paste-data-title";
    title.textContent = "Paste geochemical data";

    const hint = document.createElement("p");
    hint.textContent = "Paste cells copied from Excel, LibreOffice, Google Sheets, or a tab-separated text file.";

    const textarea = document.createElement("textarea");
    textarea.id = "paste-data-textarea";
    textarea.rows = 12;
    textarea.placeholder = "Sample_ID\tSiO2\tMgO\nS-01\t52.1\t7.4";

    const actions = document.createElement("div");
    actions.className = "data-input-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const load = document.createElement("button");
    load.type = "button";
    load.className = "btn-primary";
    load.textContent = "Load pasted data";
    actions.append(cancel, load);
    dialog.append(title, hint, textarea, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    cancel.addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
    load.addEventListener("click", async () => {
      const text = textarea.value.trim();
      if (!text) return;
      close();
      const pastedFile = new File([text], "pasted-data.tsv", { type: "text/tab-separated-values" });
      await uploadFileToServer(pastedFile);
    });

    textarea.focus();
  }

  // FastAPI `detail`/`error` may be a string, an array of validation objects, or an object.
  function errorMessage(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((v) => (v && v.msg) || JSON.stringify(v)).join("; ");
    try {
      return JSON.stringify(value);
    } catch (_err) {
      return String(value);
    }
  }

  async function uploadFileToServer(file) {
    if (APP_STATE.activeUploadController) {
      APP_STATE.activeUploadController.abort();
    }
    const controller = new AbortController();
    APP_STATE.activeUploadController = controller;

    Logger.log("INFO", "IMPORT", `Uploading file '${file.name}' (${(file.size / 1024).toFixed(1)} KB)...`);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/data/import", {
        method: "POST",
        body: formData,
        signal: controller.signal
      });

      let payload;
      try {
        payload = (await response.json()) ?? {};
      } catch (_err) {
        payload = { success: false, error: `Server returned a non-JSON response (HTTP ${response.status}).` };
      }

      if (!response.ok || payload.success === false) {
        const errMsg = errorMessage(payload.error) || errorMessage(payload.detail) || "File import failed.";
        Logger.log("ERROR", "IMPORT", errMsg);
        if (payload.info) Logger.log("INFO", "IMPORT", errorMessage(payload.info));
        switchWorkspaceView("logs");
        return;
      }

      if (Array.isArray(payload.warnings)) {
        payload.warnings.forEach((w) => Logger.log("WARN", "READER", errorMessage(w)));
      }

      const rawCols = Array.isArray(payload.columns) ? payload.columns : [];
      const rawRows = Array.isArray(payload.data) ? payload.data : [];
      const metaObj = (payload.metadata && payload.metadata.column_meta) || {};

      syncActiveDataset();
      const enriched = enrichWithSymbolAndColor(rawCols, rawRows, metaObj);

      APP_STATE.datasetName = (payload.metadata && payload.metadata.dataset_name) || file.name;
      APP_STATE.columns = enriched.columns;
      APP_STATE.rows = enriched.rows;
      APP_STATE.meta = enriched.meta;
      gridSearchTerm = "";
      const searchInput = document.getElementById("inp-grid-search");
      if (searchInput) searchInput.value = "";
      const importedCommitted = Boolean(payload.metadata && payload.metadata.committed);
      APP_STATE.committed = false;
      const datasetSnapshot = {
        datasetName: APP_STATE.datasetName,
        columns: APP_STATE.columns,
        rows: APP_STATE.rows,
        meta: APP_STATE.meta,
        committed: importedCommitted
      };
      DATASETS.push(datasetSnapshot);
      activeDatasetIndex = DATASETS.indexOf(datasetSnapshot);
      renderDatasetTabs();

      resetPlotReadiness();
      switchWorkspaceView("sheet");
      renderDataGrid();

      if (importedCommitted) {
        APP_STATE.committed = true;
        renderDataGrid();
        setValidationMessage("Confirmed project restored. Use Edit Data to unlock the sheet.");
      } else {
        triggerAutoSnapshot();
      }

      Logger.log(
        "OK",
        "IMPORT",
        `Loaded '${APP_STATE.datasetName}': ${APP_STATE.rows.length} rows, ${APP_STATE.columns.length} columns.`
      );
    } catch (err) {
      if (err.name === "AbortError") {
        Logger.log("WARN", "IMPORT", `Upload of '${file.name}' cancelled.`);
        return;
      }
      Logger.log("ERROR", "NETWORK", `Upload error: ${err.message}`);
    } finally {
      // Only clear the slot if it still belongs to this upload; a newer upload may have replaced it.
      if (APP_STATE.activeUploadController === controller) {
        APP_STATE.activeUploadController = null;
      }
    }
  }

  // Debounced so that rapid edits don't fire many large POSTs out of order.
  function triggerAutoSnapshot() {
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(sendSnapshot, SNAPSHOT_DEBOUNCE_MS);
  }

  async function sendSnapshot() {
    snapshotTimer = null;
    if (APP_STATE.columns.length === 0) return;
    try {
      const response = await fetch("/api/nest/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataset_name: APP_STATE.datasetName,
          committed: APP_STATE.committed,
          columns: APP_STATE.columns,
          meta: APP_STATE.meta,
          rows: APP_STATE.rows
        })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (err) {
      Logger.log("WARN", "AUTOSAVE", `Autosnapshot failed: ${err.message}`);
    }
  }

  async function exportClutchProject() {
    if (APP_STATE.columns.length === 0) {
      Logger.log("WARN", "EXPORT", "Cannot save empty project. Load data first.");
      return;
    }

    try {
      const response = await fetch("/api/project/export-clutch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataset_name: APP_STATE.datasetName,
          committed: APP_STATE.committed,
          columns: APP_STATE.columns,
          meta: APP_STATE.meta,
          rows: APP_STATE.rows
        })
      });

      if (!response.ok) throw new Error("Failed to export .clutch project");

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const baseName = APP_STATE.datasetName.replace(/\.[^/.]+$/, "");
      a.download = `${baseName || "project"}.clutch`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Some browsers (Safari) need the URL to stay alive a moment after click().
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      Logger.log("OK", "PROJECT", `Project exported as '${a.download}'.`);
    } catch (err) {
      Logger.log("ERROR", "PROJECT", err.message);
    }
  }

  /* ========================================================================
     8. Central Action Dispatcher (Handles BOTH Header & Workspace Buttons)
     ======================================================================== */
  function resetWorkspace() {
    if (APP_STATE.activeUploadController) {
      APP_STATE.activeUploadController.abort();
      APP_STATE.activeUploadController = null;
    }

    APP_STATE.datasetName = "Untitled";
    APP_STATE.columns = [];
    APP_STATE.rows = [];
    APP_STATE.meta = {};
    APP_STATE.committed = false;
    DATASETS.length = 0;
    activeDatasetIndex = -1;
    gridSearchTerm = "";
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
    if (hiddenFileInput) hiddenFileInput.value = "";

    resetPlotReadiness();
    switchWorkspaceView("sheet");
    renderDataGrid();
    renderDatasetTabs();
    updateWorkspaceMetaUI();
    setValidationMessage("Sheet cleared.");
    Logger.log("INFO", "WORKSPACE", "Workspace reset to clean state.");
  }

  function dispatchAppAction(action, triggerEl) {
    if (!action) return;

    switch (action) {
      case "stage:switch-view": {
        const targetView = (triggerEl && triggerEl.dataset && triggerEl.dataset.targetView) || "sheet";
        switchWorkspaceView(targetView);
        break;
      }

      case "file:import-data":
      case "file:open-project": {
        const input = getOrCreateFileInput();
        input.click();
        break;
      }

      case "file:paste-clipboard": {
        openPasteDialog();
        break;
      }

      case "file:save-project":
      case "file:save-project-as": {
        exportClutchProject();
        break;
      }

      case "file:new-workspace":
      case "sheet:clear-all": {
        resetWorkspace();
        break;
      }

      case "sheet:transpose": {
        transposeDataGrid();
        break;
      }

      case "sheet:reverse-columns": {
        reverseColumnsOrder();
        break;
      }

      case "sheet:add-symbol": {
        addStyleColumn("symbol");
        break;
      }

      case "sheet:add-color": {
        addStyleColumn("color");
        break;
      }

      case "sheet:commit-data": {
        commitDataframe();
        break;
      }

      case "sheet:validate": {
        validateDatasetOnServer();
        break;
      }

      case "sheet:edit": {
        editDataframe();
        break;
      }

      case "sheet:add-row": {
        if (APP_STATE.committed || APP_STATE.columns.length === 0) break;
        const emptyRow = {};
        APP_STATE.columns.forEach((c) => {
          emptyRow[c] = isSymbolCol(c) ? DEFAULT_SYMBOLS[0] : isColorCol(c) ? DEFAULT_PALETTE[0] : null;
        });
        APP_STATE.rows.push(emptyRow);
        renderDataGrid();
        Logger.log("INFO", "EDIT", `Added new row #${APP_STATE.rows.length}.`);
        triggerAutoSnapshot();
        break;
      }

      case "logs:clear": {
        Logger.clear();
        break;
      }

      default: {
        Logger.log("INFO", "ACTION", `Triggered action '${action}'.`);
        break;
      }
    }
  }

  /* ========================================================================
     9. Bootstrap & Event Listeners
     ======================================================================== */
  function initAppCore() {
    const plotEmpty = document.getElementById("plot-empty-state");
    if (plotEmpty) plotPlaceholderHTML = plotEmpty.innerHTML;

    // A CustomEvent dispatched inside the document can reach both document and window
    // listeners; mark it so the same action is never dispatched twice.
    const handleAction = (e) => {
      if (e.__geocodileHandled) return;
      e.__geocodileHandled = true;
      if (e.detail && e.detail.action) {
        dispatchAppAction(e.detail.action, e.detail.source || e.detail.trigger || null);
      }
    };

    window.addEventListener("geocodile:action", handleAction);
    document.addEventListener("geocodile:action", handleAction);
    window.addEventListener("app:action", handleAction);

    document.addEventListener("click", (e) => {
      if (!(e.target instanceof Element)) return;
      const actionEl = e.target.closest("[data-action]");
      if (!actionEl) return;

      // header.js already dispatches 'geocodile:action' for #main-menu.
      if (actionEl.closest("#main-menu")) return;
      // Handled by ThemeToggle.js.
      if (actionEl.dataset.action === "theme:toggle") return;

      e.preventDefault();
      dispatchAppAction(actionEl.dataset.action, actionEl);
    });

    const searchInput = document.getElementById("inp-grid-search");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        gridSearchTerm = searchInput.value.trim().toLowerCase();
        renderDataGrid();
      });
    }

    const advancedPanel = document.getElementById("advanced-filter-panel");
    const rulesBox = document.getElementById("advanced-filter-rules");
    const renderFilterRules = () => {
      if (!rulesBox) return;
      rulesBox.textContent = "";
      advancedFilters.forEach((rule, index) => {
        const row = document.createElement("div");
        row.className = "advanced-filter-rule";
        const col = document.createElement("select");
        APP_STATE.columns.forEach((name) => col.add(new Option(name, name)));
        col.value = rule.column;
        const op = document.createElement("select");
        [">=", "<=", "=", "!=", ">", "<"].forEach((value) => op.add(new Option(value, value)));
        op.value = rule.operator;
        const value = document.createElement("input");
        value.value = rule.value;
        value.placeholder = "value";
        [col, op, value].forEach((control) => control.addEventListener("input", () => { rule.column = col.value; rule.operator = op.value; rule.value = value.value; }));
        row.append(col, op, value);
        rulesBox.appendChild(row);
      });
    };
    document.getElementById("btn-advanced-filter")?.addEventListener("click", () => { advancedPanel.hidden = false; if (!advancedFilters.length) advancedFilters.push({ column: APP_STATE.columns[0] || "", operator: ">=", value: "" }); renderFilterRules(); });
    document.getElementById("btn-close-advanced-filter")?.addEventListener("click", () => { advancedPanel.hidden = true; });
    document.getElementById("btn-add-filter-rule")?.addEventListener("click", () => { advancedFilters.push({ column: APP_STATE.columns[0] || "", operator: ">=", value: "" }); renderFilterRules(); });
    document.getElementById("btn-apply-filter")?.addEventListener("click", () => { renderDataGrid(); Logger.log("INFO", "FILTER", `Applied ${advancedFilters.length} advanced filter condition(s).`); });
    document.getElementById("btn-clear-filter")?.addEventListener("click", () => { advancedFilters = []; gridSearchTerm = ""; if (searchInput) searchInput.value = ""; renderDataGrid(); if (advancedPanel) advancedPanel.hidden = true; });

    document.addEventListener("keydown", async (event) => {
      if (!selectedCells.size || APP_STATE.committed) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        const key = [...selectedCells][0];
        const [row, column] = key.split(":");
        await navigator.clipboard?.writeText(String(APP_STATE.rows[Number(row)]?.[column] ?? ""));
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        const key = [...selectedCells][0];
        const [row, column] = key.split(":");
        APP_STATE.rows[Number(row)][column] = await navigator.clipboard?.readText();
        renderDataGrid();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        selectedCells.forEach((key) => { const [row, column] = key.split(":"); if (APP_STATE.rows[Number(row)]) APP_STATE.rows[Number(row)][column] = null; });
        renderDataGrid();
        triggerAutoSnapshot();
      }
    });

    Logger.log("OK", "CORE", "GeoCodile Phase 1 Action Dispatcher & DataGrid initialized.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAppCore);
  } else {
    initAppCore();
  }
})();
