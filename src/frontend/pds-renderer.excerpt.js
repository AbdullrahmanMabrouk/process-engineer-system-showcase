/* ===================================================================
 * GENERIC PDS RENDERER - excerpt
 * -------------------------------------------------------------------
 * EXCERPT NOTICE
 * These seven functions are lifted verbatim from the single-page client
 * (index.html, ~24k lines of inline script). They are the render half of
 * the schema-driven forms engine: given any schema from schemas.excerpt.js,
 * they draw the form. They reference helpers and module state that live
 * elsewhere in that file, so this excerpt does not run standalone - it is
 * here to be read.
 *
 * No sanitisation was needed: this code contains no plant data at all,
 * which is rather the point. It has never heard of a specific department.
 * -------------------------------------------------------------------
 *
 * WHAT TO NOTICE
 *
 * renderPdsForm is the entry point, and it is short. It asks the schema
 * what it has - header fields, a cage grid, blocks, roller-direction
 * groups - and delegates. There is no `if (tabKey === 'pds_str')` in it,
 * and there is none anywhere in the file. That constraint is what makes a
 * new department a data change.
 *
 * The capabilities visible below each exist because a department needed a
 * layout the renderer could not yet express, and the fix was to teach the
 * renderer a general trick rather than to special-case the department:
 *
 *   centerWireColumn    a column that sits in the middle of a repeating
 *                       group rather than repeating with it (Stranding's
 *                       centre wire, which is one wire, not one per cage)
 *   mergedCageFields    a field that spans the whole repeating group
 *                       instead of repeating - one cell, four columns wide
 *   splitCageFields     one logical field stored as two sub-values in one
 *                       cell (tape width + thickness, tension start + end)
 *   showIf              a field that appears only when another is set,
 *                       with the chain re-evaluated on every input
 *   circleLeft          the circular pickers for roller direction, which
 *                       are drawn rather than typed because that is how
 *                       the paper form showed them
 *
 * The showIf wiring (wirePdsConditionalFields_) is worth a look for a
 * practical reason: the form is rebuilt from schema on every render, so
 * listeners are attached fresh each time and there is nothing to tear
 * down. That is a deliberate trade - re-render cost for the absence of a
 * whole class of stale-listener bug.
 *
 * See docs/forms-engine.md for the full write-up.
 * =================================================================== */

/** chipMode (optional, default falsy): when true, renders for the new
 *  PDS chip-strip/Draft-Submitted-row flow (pdsChipShowForm_ below)
 *  instead of the old local-drafts flow - only the Save entry/Save
 *  draft buttons' onclick targets and the local-drafts UI/auto-load
 *  differ; every other existing call site (all still 2-arg) is
 *  completely unaffected, chipMode is undefined -> falsy for them. */
function renderPdsForm(tabKey, schema, chipMode) {
  pdsCodeLocked_ = false;
  const body = document.getElementById('pdsBody');
  const tabDefs = pdsFormTabDefs_(schema);
  pdsActiveFormTab = tabDefs[0].key;

  if (schema.multiPage) { pdsPages_ = [{}]; pdsPageIdx_ = 0; }

  const pageContent = schema.multiPage ? pdsRenderPageContent_(schema) : null;

  let html = `<div id="pdsFormTabStrip" class="flex border-b px-5" style="border-color:var(--border-c2); gap:4px;">
    ${tabDefs.map(t => `<button class="pds-form-tab-btn" data-tab-key="${t.key}" onclick="pdsSwitchFormTab_('${t.key}')" style="padding:13px 16px; border:none; background:none; font-family:inherit; font-size:13.5px; cursor:pointer; border-bottom:3px solid transparent;">${t.label}</button>`).join('')}
  </div>
  <div class="p-5">`;

  html += `<div id="pdsTabPane_header" class="pds-tab-pane">${renderPdsHeaderFieldsHtml_(schema, tabKey)}</div>`;

  let blocksHtml = '';
  if (schema.multiPage) {
    blocksHtml = pageContent.blocksHtml;
  } else if (schema.blocks) {
    schema.blocks.forEach(b => blocksHtml += renderPdsBlockFormHtml_(b));
  } else {
    blocksHtml += renderPdsCageGridHtml_(schema);
  }
  html += `<div id="pdsTabPane_blocks" class="pds-tab-pane hidden">${blocksHtml}</div>`;

  if (schema.finalReading || schema.rollerDirectionGroups) {
    let finalHtml = '';
    if (schema.multiPage) {
      finalHtml = pageContent.finalHtml;
    } else {
      if (schema.finalReading) {
        finalHtml += '<h3 class="pds-section-head">Final Reading</h3><div class="pds-fields-grid grid grid-cols-3 gap-3 mb-4">';
        schema.finalReading.forEach(f => {
          finalHtml += `<div><label class="block text-xs text-gray-600">${f.label}</label>
            <input id="pds_f_${f.key}" class="en-input"></div>`;
        });
        finalHtml += '</div>';
      }
      finalHtml += renderPdsRollerDirectionGroupsHtml_(schema);
    }
    html += `<div id="pdsTabPane_final" class="pds-tab-pane hidden">${finalHtml}</div>`;
  }

  if (!schema.noNotes) {
    html += `<div id="pdsTabPane_notes" class="pds-tab-pane hidden">
      <h3 class="pds-section-head">Note</h3>
      <textarea id="pds_note" rows="6" placeholder="Anything the next shift should know..." class="en-input"></textarea>
    </div>`;
  }

  if (pdsmcEligible_(schema)) {
    html += `<div id="pdsTabPane_review" class="pds-tab-pane hidden"></div>`;
  }

  html += '</div>'; // .p-5

  html += `<div class="sticky bottom-0 bg-white/95 backdrop-blur-sm border-t flex gap-2 items-center flex-wrap px-5 py-3.5" style="border-color:var(--border-c2);">
    <button id="pdsSaveBtn" onclick="formsPdsSubmit_()" class="text-white font-bold text-sm" style="padding:11px 20px; border-radius:9px; border:none; background:var(--success); cursor:pointer;" title="Finish this entry and file it. Your work is already saved as you type.">Submit entry</button>
    ${schema.multiPage ? `<button id="pdsAddPageBtn" onclick="pdsAddPage_('${tabKey}')" class="font-bold text-sm" style="padding:11px 20px; border-radius:9px; border:1.5px solid var(--success); background:#fff; color:var(--success); cursor:pointer;">+ Add Page</button>
    <button id="pdsRemovePageBtn" onclick="pdsRemovePage_('${tabKey}')" class="font-bold text-sm" style="padding:11px 20px; border-radius:9px; border:1.5px solid var(--danger); background:#fff; color:var(--danger); cursor:pointer;">Remove Page</button>` : ''}
    <button onclick="pdsPrintForm('${tabKey}')" class="font-bold text-sm" style="padding:11px 20px; border-radius:9px; border:1.5px solid var(--border-c); background:#fff; color:oklch(30% 0.02 60); cursor:pointer;">Print</button>
    <button onclick="formsPdsSaveNow_()" class="font-bold text-sm" style="padding:11px 20px; border-radius:9px; border:none; background:oklch(93% 0.01 70); color:oklch(35% 0.02 60); cursor:pointer;" title="Not required - this entry saves itself as you type. Use this if you want to be sure right now.">Save now</button>
    <p id="pdsMsg" class="text-sm ml-2"></p>
    <span class="flex-1"></span>
    ${chipMode ? `<span id="pdsSaveStatus" class="text-xs" style="color:var(--ink-soft);"></span>` : ''}
    ${schema.multiPage ? `<span class="flex items-center gap-1.5 mr-1">
      <button id="pdsPagePrevBtn" onclick="pdsGoToPage_('${tabKey}', -1)" disabled class="font-bold text-sm" style="width:28px; height:28px; border-radius:7px; border:1px solid var(--border-c); background:#fff; cursor:pointer;">&lt;</button>
      <span id="pdsPageNavLabel" class="text-xs font-semibold" style="color:var(--ink-soft); min-width:74px; text-align:center;">Page 1 of 1</span>
      <button id="pdsPageNextBtn" onclick="pdsGoToPage_('${tabKey}', 1)" disabled class="font-bold text-sm" style="width:28px; height:28px; border-radius:7px; border:1px solid var(--border-c); background:#fff; cursor:pointer;">&gt;</button>
    </span>` : ''}
    <span id="pdsStepIndicator" class="text-xs" style="color:var(--ink-softer);">Step 1 of ${tabDefs.length}</span>
  </div>
    ${chipMode ? '' : '<div id="pdsDraftsList" class="px-5 pb-3"></div>'}`;

  body.innerHTML = html;
  body.dataset.schema = JSON.stringify(schema);
  body.dataset.tabKey = tabKey;
  body.dataset.tabDefs = JSON.stringify(tabDefs);
  body.dataset.activeDraftId = '';
  pdsSwitchFormTab_(tabDefs[0].key);

  wirePdsAutoCode_(tabKey, schema);
  // allowOther first: it marks the selects and adds "+ Add new...", which
  // the dependent repopulate below then re-applies after each rebuild.
  wirePdsAllowOther_(schema);
  wirePdsDependentOptions_(schema);
  wirePdsConditionalFields_(schema);
  wirePdsBlockConditionalFields_(schema);
  wirePdsWorkOrderLookup_(schema, tabKey);
  wirePdsTapeToggle_(schema);
  wirePdsRollerDirectionGroups_(schema);
  pdsWireVarianceColoring_(schema);
  wirePdsComputedAvgFields_(schema);
  wirePdsChartBlocks_(schema);
  pdsPrefillNameField_(schema);
  if (schema.multiPage) pdsUpdatePageNavUi_();

  // The old auto-restore-last-local-draft block lived here. It is
  // unnecessary now: the forms engine decides which record to open
  // (formsPdsShow_) and applies its values before this point, from a
  // store that survives refreshes and follows the account across
  // devices - which is what that block was approximating per-browser.
  pdsmcEnhanceForm_(tabKey, schema);
}

function renderPdsHeaderFieldsHtml_(schema, tabKey) {
  const autoCode = !!PDS_CODE_FORMULAS[tabKey];
  let html = '<div class="pds-header-grid grid grid-cols-3 gap-3 mb-4">';
  schema.header.forEach(f => {
    const isCode = autoCode && f.key === 'pdsCode';
    const hideStyle = f.showIf ? ' style="display:none;"' : '';
    if (f.type === 'checkbox') {
      html += `<div${hideStyle} data-showif-field="${f.key}"><label class="inline-flex items-center gap-2 text-xs text-gray-600 mt-5">
        <input type="checkbox" id="pds_h_${f.key}">${f.label}</label></div>`;
    } else if (f.type === 'select') {
      const opts = (f.options || []).map(o => {
        const val = (o && typeof o === 'object') ? o.value : o;
        const lbl = (o && typeof o === 'object') ? o.label : o;
        return `<option value="${val}">${lbl}</option>`;
      }).join('');
      html += `<div${hideStyle} data-showif-field="${f.key}"><label class="block text-xs text-gray-600">${f.label}</label>
        <select id="pds_h_${f.key}" class="border p-2 rounded w-full text-sm"><option value=""></option>${opts}</select></div>`;
    } else if (f.type === 'photo') {
      html += `<div${hideStyle} data-showif-field="${f.key}"><label class="block text-xs text-gray-600">${f.label}</label>
        <input id="pds_h_${f.key}" type="hidden">
        <input id="pds_h_${f.key}__picker" type="file" accept="image/jpeg,image/png,image/heic,image/heif,image/webp"
          onchange="pdsPhotoSelected_('pds_h', '${f.key}')" style="display:none;">
        ${photoPickerTriggerHtml_('pds_h_' + f.key + '__picker')}
        <div id="pds_h_${f.key}__status" class="text-xs mt-1"></div></div>`;
    } else if (f.type === 'document') {
      html += `<div${hideStyle} data-showif-field="${f.key}" class="col-span-3"><label class="block text-xs text-gray-600">${f.label}</label>
        <input id="pds_h_${f.key}" type="hidden">
        <input id="pds_h_${f.key}__picker" type="file" accept="${pdsDocAccept_(f)}"
          onchange="pdsDocSelected_('pds_h', '${f.key}')" style="display:none;">
        ${docPickerTriggerHtml_('pds_h_' + f.key + '__picker', f)}
        <div id="pds_h_${f.key}__status" class="text-xs mt-1"></div></div>`;
    } else if (f.type === 'textarea') {
      html += `<div${hideStyle} data-showif-field="${f.key}" class="col-span-3"><label class="block text-xs text-gray-600">${f.label}</label>
        <textarea id="pds_h_${f.key}" rows="2" class="border p-2 rounded w-full text-sm"></textarea></div>`;
    } else {
      const isWorkOrder = f.key === 'workOrder';
      html += `<div${hideStyle} data-showif-field="${f.key}"><label class="block text-xs text-gray-600">${f.label}</label>
        <input id="pds_h_${f.key}" type="${f.type === 'date' ? 'date' : 'text'}" class="border p-2 rounded w-full text-sm${isCode ? ' bg-gray-100' : ''}"${isCode ? ' readonly' : ''}>
        ${isWorkOrder ? `<div id="pds_h_workOrder__status" class="text-xs mt-1" style="color:var(--ink-soft);"></div>` : ''}</div>`;
    }
  });
  html += '</div>';
  return html;
}

function renderPdsBlockFormHtml_(block) {
  // Its own module handles it - none of the table/HMI/zone machinery
  // below applies to a variable-length list.
  if (block.type === 'repeat') return pdsRepeatBlockHtml_(block);
  const pdsHmiRowKeys_ = block.type === 'table' ? block.rowLabels.map(r => r.key) : [];
  const pdsHmiEligible_ = block.type === 'table' && pdsHmiRowKeys_.includes('set') && pdsHmiRowKeys_.includes('actual');
  if (pdsHmiEligible_) pdsHmiBlockRegistry_[block.key] = block;
  // Eligibility is the schema's own zoneColsEditable flag, NOT "was
  // zoneMatrixBlock_ used": Assembly/Screening's Tape 1-3 share that
  // helper and are not editable, while the Bleeding ramp is editable
  // without being a Set/Actual temperature matrix at all.
  const pdsZoneCfgEligible_ = block.type === 'table' && !!block.zoneColsEditable;
  // Everything from here rightwards is a fixed non-zone column (Bleeding's
  // RPM/output metrics): shown as usual, but never renamed or removed, and
  // a newly added zone is inserted in front of it.
  const pdsZoneColsEnd_ = block.zoneColsEnd === undefined
    ? (block.cols || []).length : block.zoneColsEnd;
  if (pdsZoneCfgEligible_) pdsZoneColBlockRegistry_[block.key] = block;
  const headBtn_ = (onclick, label) => `<button type="button" onclick="${onclick}" class="text-xs px-2.5 py-1 rounded" style="background:#fff;border:1px solid var(--border-c);cursor:pointer;font-family:'IBM Plex Sans',system-ui,sans-serif;font-weight:600;">${label}</button>`;
  const headActions_ = [];
  if (pdsHmiEligible_) {
    headActions_.push(headBtn_(`pdsHmiCaptureStart_('${block.key}', true)`, 'Scan HMI'));
    headActions_.push(headBtn_(`pdsHmiCaptureStart_('${block.key}', false)`, 'Upload HMI Photo'));
  }
  if (pdsZoneCfgEligible_ && pdsZoneColsCanManage_()) {
    headActions_.push(headBtn_(`pdsZoneColsEditStart_('${block.key}')`, 'Edit columns'));
  }
  let html = `<div class="mb-4"><h3 class="pds-section-head" style="display:flex;align-items:center;justify-content:space-between;">
    <span>${block.title}</span>
    ${headActions_.length ? `<span style="display:flex;gap:6px;">${headActions_.join('')}</span>` : ''}
  </h3>`;
  if (block.type === 'fields') {
    const circleFields = block.fields.filter(f => f.circleLeft !== undefined);
    const plainFields = block.fields.filter(f => f.circleLeft === undefined);
    if (circleFields.length) html += `<div id="pds_b_${block.key}_circlewrap">${renderPdsCircleGroupsHtml_(block.key, circleFields)}</div>`;
    html += '<div class="pds-fields-grid grid grid-cols-3 gap-3">';
    plainFields.forEach(f => {
      const hideStyle = f.showIf ? ' style="display:none;"' : '';
      const wrapId = ` id="pds_bwrap_${block.key}_${f.key}"`;
      if (f.type === 'photo') {
        html += `<div${wrapId}${hideStyle}><label class="block text-xs text-gray-600">${f.label}</label>
          <input id="pds_b_${block.key}_${f.key}" type="hidden">
          <input id="pds_b_${block.key}_${f.key}__picker" type="file" accept="image/jpeg,image/png,image/heic,image/heif,image/webp"
            onchange="pdsPhotoSelected_('pds_b_${block.key}', '${f.key}')" style="display:none;">
          ${photoPickerTriggerHtml_('pds_b_' + block.key + '_' + f.key + '__picker')}
          <div id="pds_b_${block.key}_${f.key}__status" class="text-xs mt-1"></div></div>`;
      } else if (f.type === 'document') {
        html += `<div${wrapId}${hideStyle} class="col-span-2"><label class="block text-xs text-gray-600">${f.label}</label>
          <input id="pds_b_${block.key}_${f.key}" type="hidden">
          <input id="pds_b_${block.key}_${f.key}__picker" type="file" accept="${pdsDocAccept_(f)}"
            onchange="pdsDocSelected_('pds_b_${block.key}', '${f.key}')" style="display:none;">
          ${docPickerTriggerHtml_('pds_b_' + block.key + '_' + f.key + '__picker', f)}
          <div id="pds_b_${block.key}_${f.key}__status" class="text-xs mt-1"></div></div>`;
      } else if (f.type === 'select') {
        // A select declared in a fields-block used to render as a plain
        // text box: the options existed in the schema and were never
        // drawn. Same for date and textarea below - the block renderer
        // only ever knew 'photo' and 'everything else'.
        const opts = (f.options || []).map(o => {
          const val = (o && typeof o === 'object') ? o.value : o;
          const lbl = (o && typeof o === 'object') ? o.label : o;
          return `<option value="${pdsmcEsc_(val)}">${pdsmcEsc_(lbl)}</option>`;
        }).join('');
        html += `<div${wrapId}${hideStyle}><label class="block text-xs text-gray-600">${f.label}</label>
          <select id="pds_b_${block.key}_${f.key}" class="border p-2 rounded w-full text-sm"><option value=""></option>${opts}</select></div>`;
      } else if (f.type === 'checkbox') {
        html += `<div${wrapId}${hideStyle}><label class="inline-flex items-center gap-2 text-xs text-gray-600 mt-5">
          <input type="checkbox" id="pds_b_${block.key}_${f.key}">${f.label}</label></div>`;
      } else if (f.type === 'textarea') {
        html += `<div${wrapId}${hideStyle} style="grid-column:1 / -1;"><label class="block text-xs text-gray-600">${f.label}</label>
          <textarea id="pds_b_${block.key}_${f.key}" rows="2" class="border p-2 rounded w-full text-sm"></textarea></div>`;
      } else {
        const ro = f.computed ? ' readonly style="background:#f3f4f6;"' : '';
        // A date gets the browser's own day picker rather than a text
        // box somebody has to type a date into.
        const type = (f.type === 'date') ? ' type="date"'
          : (f.type === 'number' ? ' type="number" inputmode="decimal"' : '');
        html += `<div${wrapId}${hideStyle}><label class="block text-xs text-gray-600">${f.label}</label>
          <input id="pds_b_${block.key}_${f.key}"${type} class="border p-2 rounded w-full text-sm"${ro}></div>`;
      }
    });
    html += '</div>';
  } else if (block.type === 'table') {
    if (pdsZoneCfgEligible_ && pdsZoneColsCanManage_()) {
      html += `<div id="pds_zonecols_bar_${block.key}" style="display:none;"></div>`;
    }
    html += `<div class="overflow-x-auto" id="pds_b_${block.key}_tablewrap"><table class="text-sm border w-full"><thead><tr><th class="border p-1 bg-gray-50"></th>`;
    // data-col-key/data-col-label let the column editor rewrite a header
    // in place (and restore it on Cancel) without re-rendering the form
    // and losing whatever is typed into the cells.
    block.cols.forEach((c, i) => {
      const editable = pdsZoneCfgEligible_ && i < pdsZoneColsEnd_;
      const attrs = editable
        ? ` data-zonecol-block="${block.key}" data-zonecol-key="${c.key}" data-zonecol-added="${c.added ? '1' : ''}" data-zonecol-label="${pdsZoneColsAttr_(c.label)}"`
        : '';
      html += `<th class="border p-1 bg-gray-50"${attrs}>${c.label}</th>`;
    });
    html += '</tr></thead><tbody>';
    block.rowLabels.forEach(r => {
      html += `<tr><td class="border p-1 font-medium bg-gray-50">${r.label}</td>`;
      block.cols.forEach(c => {
        const ro = c.computed ? ' readonly style="background:#f3f4f6;"' : '';
        html += `<td class="border p-1"><input id="pds_b_${block.key}_${r.key}_${c.key}" class="w-full text-sm p-1"${ro}></td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    const rowKeys = block.rowLabels.map(r => r.key);
    const hasVariancePair = pdsActualRowKeys_(rowKeys).length && (rowKeys.includes('set') || rowKeys.includes('tds'));
    if (hasVariancePair) {
      html += `<p class="text-xs mb-2" style="color:var(--ink-softer);">
        <span class="inline-block rounded" style="width:10px;height:10px;background:#fee2e2;vertical-align:-1px;margin-right:5px;"></span>Actual above target
        <span class="inline-block rounded ml-3" style="width:10px;height:10px;background:#dbeafe;vertical-align:-1px;margin-right:5px;"></span>Actual below target</p>`;
    }
    if (block.extraFields && block.extraFields.length) {
      html += '<div class="pds-fields-grid grid grid-cols-4 gap-3 mt-2">';
      block.extraFields.forEach(f => {
        const hideStyle = f.showIf ? ' style="display:none;"' : '';
        if (f.type === 'checkbox') {
          html += `<div id="pds_bwrap_${block.key}_x_${f.key}"${hideStyle}><label class="inline-flex items-center gap-2 text-xs text-gray-600 mt-5">
            <input type="checkbox" id="pds_b_${block.key}_x_${f.key}">${f.label}</label></div>`;
        } else if (f.type === 'select') {
          const opts = (f.options || []).map(o => {
            const val = (o && typeof o === 'object') ? o.value : o;
            const lbl = (o && typeof o === 'object') ? o.label : o;
            return `<option value="${val}">${lbl}</option>`;
          }).join('');
          html += `<div id="pds_bwrap_${block.key}_x_${f.key}"${hideStyle}><label class="block text-xs text-gray-600">${f.label}</label>
            <select id="pds_b_${block.key}_x_${f.key}" class="border p-2 rounded w-full text-sm"><option value=""></option>${opts}</select></div>`;
        } else if (f.type === 'photo') {
          // Spans the full 4-column grid so the picker and the "Photo
          // attached" link sit on their own row directly under the
          // table, rather than being squeezed into a quarter-width cell
          // alongside the numeric extras.
          html += `<div id="pds_bwrap_${block.key}_x_${f.key}"${hideStyle} class="col-span-4"><label class="block text-xs text-gray-600">${f.label}</label>
            <input id="pds_b_${block.key}_x_${f.key}" type="hidden">
            <input id="pds_b_${block.key}_x_${f.key}__picker" type="file" accept="image/jpeg,image/png,image/heic,image/heif,image/webp"
              onchange="pdsPhotoSelected_('pds_b_${block.key}_x', '${f.key}')" style="display:none;">
            ${photoPickerTriggerHtml_('pds_b_' + block.key + '_x_' + f.key + '__picker')}
            <div id="pds_b_${block.key}_x_${f.key}__status" class="text-xs mt-1"></div></div>`;
        } else if (f.type === 'document') {
          html += `<div id="pds_bwrap_${block.key}_x_${f.key}"${hideStyle} class="col-span-4"><label class="block text-xs text-gray-600">${f.label}</label>
            <input id="pds_b_${block.key}_x_${f.key}" type="hidden">
            <input id="pds_b_${block.key}_x_${f.key}__picker" type="file" accept="${pdsDocAccept_(f)}"
              onchange="pdsDocSelected_('pds_b_${block.key}_x', '${f.key}')" style="display:none;">
            ${docPickerTriggerHtml_('pds_b_' + block.key + '_x_' + f.key + '__picker', f)}
            <div id="pds_b_${block.key}_x_${f.key}__status" class="text-xs mt-1"></div></div>`;
        } else {
          html += `<div id="pds_bwrap_${block.key}_x_${f.key}"${hideStyle}><label class="block text-xs text-gray-600">${f.label}</label>
            <input id="pds_b_${block.key}_x_${f.key}" class="border p-2 rounded w-full text-sm"></div>`;
        }
      });
      html += '</div>';
    }
    if (block.chartConfig) html += `<div id="pds_b_${block.key}_charts"></div>`;
  }
  html += '</div>';
  return html;
}

/** ===== LEGACY CAGE-GRID RENDERING (pds_str) - extended with an optional
 *  Center Wire column, rows that merge into one value across all columns,
 *  rows split into two sub-cells per column, and a toggle-driven show/hide
 *  group (e.g. tape rows only relevant "With Tape"). Every extra capability
 *  is opt-in via schema flags, so a future cage-grid dept can pick and choose. */
function renderPdsCageGridHtml_(schema) {
  const hasCenter = !!schema.centerWireColumn;
  const merged = schema.mergedCageFields || [];
  const split = schema.splitCageFields || {};
  const tapeFields = schema.tapeCageFields || [];

  let html = '<h3 class="pds-section-head">Actual (Mch/Con.)</h3>';
  html += '<div class="overflow-x-auto" id="pds_c_tablewrap"><table class="text-sm border w-full mb-4"><thead><tr><th class="border p-1 bg-gray-50">Field</th>';
  if (hasCenter) html += '<th class="border p-1 bg-gray-50">Center Wire</th>';
  schema.cageGroups.forEach(cg => html += `<th class="border p-1 bg-gray-50">${cg}</th>`);
  html += '</tr></thead><tbody>';

  schema.cageFields.forEach(f => {
    const isTape = tapeFields.includes(f.key);
    const rowAttrs = isTape ? ' data-tape-row="1" style="display:none;"' : '';
    if (merged.includes(f.key)) {
      const colspan = 1 + (hasCenter ? 1 : 0) + schema.cageGroups.length;
      html += `<tr${rowAttrs}><td class="border p-1 font-medium">${f.label}</td><td class="border p-1" colspan="${colspan}"><input id="pds_c_${f.key}__ALL" class="w-full text-sm p-1"></td></tr>`;
      return;
    }
    html += `<tr${rowAttrs}><td class="border p-1 font-medium">${f.label}</td>`;
    if (hasCenter) html += `<td class="border p-1"><input id="pds_c_${f.key}__CENTER" class="w-full text-sm p-1"></td>`;
    const splitCfg = split[f.key];
    schema.cageGroups.forEach(cg => {
      if (splitCfg) {
        html += '<td class="border p-1"><div class="flex gap-1">';
        splitCfg.suffixes.forEach((suf, i) => {
          html += `<input id="pds_c_${f.key}__${cg}__${suf}" placeholder="${splitCfg.labels[i]}" class="text-sm p-1" style="width:48%">`;
        });
        html += '</div></td>';
      } else {
        html += `<td class="border p-1"><input id="pds_c_${f.key}__${cg}" class="w-full text-sm p-1"></td>`;
      }
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  return html;
}

function renderPdsRollerDirectionGroupsHtml_(schema) {
  const cfg = schema.rollerDirectionGroups;
  if (!cfg) return '';
  let html = '<h3 class="pds-section-head">Direction of Rollers</h3><div class="mb-4">';
  cfg.groups.forEach(g => {
    html += `<p class="text-xs font-semibold text-gray-600 text-center mb-1">${g.label}</p><div class="pds-roller-row flex justify-center gap-4 mb-3 flex-wrap">`;
    for (let n = 1; n <= cfg.pickersPerGroup; n++) {
      const id = `pds_roller_${g.key}_p${n}`;
      html += `<div class="flex flex-col items-center gap-1">
        <input type="hidden" id="${id}">
        <div id="${id}_wrap" style="position:relative; width:90px; height:90px;"></div>
      </div>`;
    }
    html += '</div>';
  });
  html += '</div>';
  return html;
}

/** A compass "point" is normally one input, but multiple fields can share
 *  the same physical spot (circlePoint, or falling back to matching
 *  circleLeft/circleTop) - e.g. CV Sikora's cable cross-section: at each
 *  of the 8 positions, ISC/INS/OSC layer thickness are 3 separate readings
 *  at the same point, rendered as a small labeled cluster instead of one
 *  input. Fields without a shared point still render as a single input. */
function renderPdsCircleFieldsHtml_(blockKey, circleFields, maxWidthPx) {
  let html = `<div class="pds-circle-scroll"><div class="pds-circle-wrap" style="position:relative; width:100%; max-width:${maxWidthPx || 320}px; aspect-ratio:1; margin:0 auto 12px;">`;
  html += `<svg viewBox="0 0 100 100" style="position:absolute;top:0;left:0;width:100%;height:100%;">
    <circle cx="50" cy="50" r="42" fill="none" stroke="#cbd5e1" stroke-width="0.6"/>
    <circle cx="50" cy="50" r="22" fill="none" stroke="#cbd5e1" stroke-width="0.6"/>
  </svg>`;
  const points = [];
  const byPoint = {};
  circleFields.forEach(f => {
    const posKey = f.circlePoint !== undefined ? f.circlePoint : (f.circleLeft + '_' + f.circleTop);
    if (!byPoint[posKey]) { byPoint[posKey] = { left: f.circleLeft, top: f.circleTop, label: f.label, fields: [] }; points.push(posKey); }
    byPoint[posKey].fields.push(f);
  });
  points.forEach(posKey => {
    const pt = byPoint[posKey];
    html += `<div style="position:absolute; left:${pt.left}%; top:${pt.top}%; transform:translate(-50%,-50%); text-align:center;">
      <div style="font-size:12px; font-weight:600; color:#374151; margin-bottom:3px; white-space:nowrap;">${pt.label}</div>`;
    if (pt.fields.length > 1) {
      html += '<div style="display:flex; gap:5px;">';
      pt.fields.forEach(f => {
        html += `<div style="text-align:center;">
          ${f.circleSubLabel ? `<div style="font-size:10px; font-weight:700; color:#6b7280; margin-bottom:1px;">${f.circleSubLabel}</div>` : ''}
          <input id="pds_b_${blockKey}_${f.key}" class="border rounded text-center" style="width:52px; height:34px; font-size:14px; padding:2px;">
        </div>`;
      });
      html += '</div>';
    } else {
      html += `<input id="pds_b_${blockKey}_${pt.fields[0].key}" class="border rounded text-center" style="width:64px; height:34px; font-size:14px; padding:2px;">`;
    }
    html += '</div>';
  });
  html += '</div></div>';
  return html;
}

/** Wires 'With Tape' / 'With Powder' / ... checkboxes, and value-matched
 *  selects (e.g. Conductor Type = Sector), to show/hide + clear the header
 *  fields declared with a matching showIf, generically for any dept.
 *  showIf is either a checkbox field key (truthy = show), or
 *  { field, equals } to show only when that field's value matches. */
function wirePdsConditionalFields_(schema) {
  schema.header.forEach(f => {
    if (!f.showIf) return;
    const cond = typeof f.showIf === 'string' ? { field: f.showIf, equals: true } : f.showIf;
    const toggleEl = document.getElementById('pds_h_' + cond.field);
    const wrapEl = document.querySelector(`[data-showif-field="${f.key}"]`);
    if (!toggleEl || !wrapEl) return;
    const apply = () => {
      const on = cond.equals === true ? toggleEl.checked : toggleEl.value === cond.equals;
      wrapEl.style.display = on ? '' : 'none';
      const fieldEl = document.getElementById('pds_h_' + f.key);
      if (!on && fieldEl) fieldEl.value = '';
    };
    toggleEl.addEventListener('change', apply);
    toggleEl.addEventListener('input', apply);
    apply();
  });
}