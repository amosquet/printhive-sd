/**
 * Submission flow for the /submit page.
 *
 * Mirrors the deployed PrintHive SubmissionForm: step 1 collects part details
 * (title, STL/OBJ batch, default print settings, per-part options, notes,
 * Purdue email) next to the sliced 3D preview; step 2 reviews every part;
 * confirming uploads the models to the Python API and displays its receipt.
 */
import { IDENTITY_ROTATION } from '@time-estimator/browser-preview/pose';
import { validateFiles, MAX_BATCH_SIZE, formatMiB } from './file-validation.js';
import { PrintPreview } from './print-preview';
import { PREVIEW_PRINTERS, selectPreviewPrinter, fitsPreviewPrinter } from './preview-profile';
import { loadMyPrints, saveMyPrints, type MyPrint } from './queue-page';
import {
  MATERIALS,
  PROFILES,
  SUPPORTS,
  supportLabel,
  getDefaultMaterial,
  getDefaultColor,
  getProfile,
  defaultPartSettings,
  resolvePartSettings,
  normalizePartOverrides,
  partScale,
  partSupportAngle,
  resolveColor,
  checkPrinterFit,
  type SharedPartSettings,
  type PartOptions,
  type ResolvedPartSettings,
} from './print-settings';

interface FileEntry {
  file: File;
  dims: { min: number[]; max: number[] } | null;
  parseError?: string;
  /** In-flight (or settled) bounding-box parse; awaited before validating. */
  parsePromise?: Promise<void>;
}

interface FlowState {
  files: FileEntry[];
  activeIndex: number;
  fileOptionsOpen: boolean;
  moreSettingsOpen: boolean;
  orientations: Map<File, number[]>;
  partOptions: Map<File, PartOptions>;
  global: SharedPartSettings;
  title: string;
  notes: string;
  email: string;
  step: 'details' | 'review' | 'done';
  busy: boolean;
}

const DEFAULT_ROTATION: number[] = [...IDENTITY_ROTATION];

const state: FlowState = {
  files: [],
  activeIndex: 0,
  fileOptionsOpen: true,
  moreSettingsOpen: false,
  orientations: new Map(),
  partOptions: new Map(),
  global: defaultPartSettings(MATERIALS),
  title: '',
  notes: '',
  email: '',
  step: 'details',
  busy: false,
};

let preview: PrintPreview;
let activeUpload: XMLHttpRequest | null = null;
let submissionId: string | null = null;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const selector = id.startsWith('#') ? id : `#${id}`;
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element ${selector}`);
  return found;
};
const esc = (value: string) => value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

function activeEntry(): FileEntry | null {
  return state.files[state.activeIndex] ?? state.files[0] ?? null;
}
function activeResolved(): ResolvedPartSettings {
  const entry = activeEntry();
  return resolvePartSettings(state.global, entry ? state.partOptions.get(entry.file) : undefined, MATERIALS);
}
function colorCode(settings: ResolvedPartSettings): string | undefined {
  const material = MATERIALS.find((m) => m.name.toLowerCase() === settings.material.toLowerCase());
  return material?.colors.find((c) => c.name.toLowerCase() === settings.color.toLowerCase())?.code;
}
function scaledDims(entry: FileEntry, settings: ResolvedPartSettings): number[] {
  const scale = partScale(settings) ?? 1;
  if (!entry.dims) return [];
  return entry.dims.min.map((value, i) => (entry.dims!.max[i] - value) * scale);
}
function fitsAnyPrinter(dims: number[]): boolean {
  return PREVIEW_PRINTERS.some((printer) => checkPrinterFit(dims, printer));
}
const LARGEST_BED = '325 × 320 × 325 mm';

// ---------- preview wiring ----------

function pushPreview() {
  const entry = activeEntry();
  const resolved = activeResolved();
  const profile = getProfile(resolved.profile);
  const scale = partScale(resolved);
  preview.update({
    file: entry?.file ?? null,
    rotation: (entry && state.orientations.get(entry.file)) || DEFAULT_ROTATION,
    mirror: resolved.mirror,
    scale: scale ?? 1,
    color: colorCode(resolved) ?? '',
    colorName: resolved.color,
    copies: resolved.copies,
    units: resolved.units,
    infill: profile.infill,
    walls: profile.walls,
    layerHeight: profile.layerHeight,
    supports: resolved.supports,
    supportAngle: partSupportAngle(resolved) ?? undefined,
    settingsValid: scale !== null && partSupportAngle(resolved) !== null,
    disabled: state.busy,
    retainedFiles: state.files.map((entry) => entry.file),
  });
}

// ---------- file handling ----------

function parseDims(entry: FileEntry): Promise<void> {
  const promise = new Promise<void>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/stl.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      entry.parseError = 'Could not read this model file.';
      resolve();
      return;
    }
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.error) entry.parseError = String(data.error);
      else entry.dims = { min: data.min, max: data.max };
      resolve();
    };
    worker.onerror = () => {
      worker.terminate();
      entry.parseError = 'Could not read this model file.';
      resolve();
    };
    worker.postMessage({
      file: entry.file,
      name: entry.file.name,
      // measure under the saved orientation so printer-fit uses the rotated bounding box
      rotation: state.orientations.get(entry.file) ?? DEFAULT_ROTATION,
      mirror: false,
      scale: 1,
      hull: false,
    });
  });
  entry.parsePromise = promise;
  return promise;
}

async function addFiles(selected: File[]) {
  if (!selected.length) return;
  clearFileMessage();
  const existing = state.files;
  const merged = [...existing.map((entry) => entry.file)];
  for (const file of selected) {
    const index = merged.findIndex((f) => f.name === file.name && f.size === file.size);
    if (index >= 0) merged[index] = file;
    else merged.push(file);
  }
  if (merged.length > MAX_BATCH_SIZE) {
    setFileMessage(`You can submit up to ${MAX_BATCH_SIZE} model files in a single batch.`);
    return;
  }
  const result = validateFiles(merged);
  if (!result.ok) {
    setFileMessage(result.error);
    return;
  }
  const firstAdd = state.files.length === 0;
  state.files = merged.map((file) => existing.find((entry) => entry.file === file) ?? { file, dims: null });
  state.orientations = new Map([...state.orientations].filter(([file]) => merged.includes(file)));
  state.partOptions = new Map([...state.partOptions].filter(([file]) => merged.includes(file)));
  if (firstAdd) {
    state.activeIndex = 0;
    state.fileOptionsOpen = true;
  }
  renderFileList();
  for (const entry of state.files) if (!entry.dims && !entry.parseError) void parseDims(entry).then(() => renderFileList());
  updateDropZone();
  pushPreview();
}

function removeFileAt(index: number) {
  const entry = state.files[index];
  if (!entry) return;
  state.files = state.files.filter((_, i) => i !== index);
  state.orientations.delete(entry.file);
  state.partOptions.delete(entry.file);
  if (index < state.activeIndex) state.activeIndex--;
  else if (state.activeIndex >= state.files.length) state.activeIndex = Math.max(0, state.files.length - 1);
  clearFileMessage();
  renderFileList();
  updateDropZone();
  pushPreview();
}

function setFileMessage(message: string) {
  const el = $('#file-message');
  el.textContent = message;
  flagInvalid($('#drop-zone'));
}
function clearFileMessage() {
  $('#file-message').textContent = '';
  unflag($('#drop-zone'));
}

/** Red-outline the problematic field and smooth-scroll to it. */
function flagInvalid(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.add('invalid');
  el.setAttribute('aria-invalid', 'true');
  el.focus({ preventScroll: true });
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function unflag(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.remove('invalid');
  el.removeAttribute('aria-invalid');
}
function clearInvalid(): void {
  document.querySelectorAll('.invalid').forEach((el) => unflag(el as HTMLElement));
}
function setFormMessage(message: string) {
  const el = state.step === 'review' ? $('#review-message') : $('#form-message');
  el.textContent = message;
  el.hidden = !message;
}
function clearMessages() {
  for (const id of ['file-message', 'form-message', 'review-message', 'title-message', 'email-message']) $(id).textContent = '';
  $('#form-message').hidden = true;
  $('#review-message').hidden = true;
  clearInvalid();
}

function updateDropZone() {
  const files = state.files.map((entry) => entry.file);
  const title = $('#file-title');
  const detail = $('#file-detail');
  if (!files.length) {
    title.textContent = 'Upload 3D model files';
    detail.innerHTML = 'Drag and drop here, or <u>browse files</u>';
  } else if (files.length === 1) {
    title.textContent = files[0].name;
    detail.textContent = formatMiB(files[0].size);
  } else {
    title.textContent = `${files.length} model files selected`;
    const total = files.reduce((sum, f) => sum + f.size, 0);
    detail.textContent = `${formatMiB(total)} total`;
  }
}

// ---------- rendering ----------

function partSummary(entry: FileEntry, index: number): string {
  const part = state.partOptions.get(entry.file);
  const copies = part?.copies ?? 1;
  const bits = [`${copies} ${copies === 1 ? 'copy' : 'copies'}`];
  if (part?.mirror) bits.push('Mirrored');
  if (part && Object.keys(part.overrides).length > 0) bits.push('Custom settings');
  if (index === state.activeIndex) bits.push('Previewing');
  if (entry.parseError) bits.push('Unreadable');
  else if (entry.dims) {
    const dims = scaledDims(entry, resolvePartSettings(state.global, part, MATERIALS));
    if (dims.length && !fitsAnyPrinter(dims)) bits.push('Too large');
  }
  return bits.join(' · ');
}

function renderFileList() {
  const list = $('#file-list');
  const wrap = $('#batch-file-list');
  const count = $('#file-count');
  wrap.hidden = state.files.length === 0;
  count.textContent = `${state.files.length} ${state.files.length === 1 ? 'file' : 'files'}`;
  $('#clear-files').hidden = state.files.length <= 1;
  list.innerHTML = state.files
    .map((entry, i) => {
      const expanded = i === state.activeIndex && state.fileOptionsOpen;
      return `<li class="${i === state.activeIndex ? 'active' : ''}">
  <div class="batch-file-row">
    <button type="button" class="batch-file-select" data-action="select-file" data-index="${i}" aria-expanded="${expanded}" aria-controls="file-options-${i}" aria-pressed="${i === state.activeIndex}">
      <span class="batch-file-details">
        <span class="batch-file-name">${esc(entry.file.name)}</span>
        <span class="batch-file-options-summary">${esc(partSummary(entry, i))}</span>
      </span>
      <span class="batch-file-size mono">${formatMiB(entry.file.size)}</span>
      <span class="file-options-chevron" aria-hidden="true">›</span>
    </button>
    <button type="button" class="batch-file-remove" data-action="remove-file" data-index="${i}" aria-label="Remove ${esc(entry.file.name)}">×</button>
  </div>
  <div id="file-options-${i}" class="batch-file-options" ${expanded ? '' : 'hidden'}>
    ${expanded ? fileOptionsHtml() : ''}
  </div>
</li>`;
    })
    .join('');
}

function overrideSelect(key: keyof SharedPartSettings, label: string, options: Array<[string, string]>, inherited: string): string {
  const entry = activeEntry();
  const overrides = (entry && state.partOptions.get(entry.file)?.overrides) || {};
  const value = overrides[key];
  return `<label>${esc(label)}
    <select data-override="${key}" aria-label="${esc(label)} for this part">
      <option value="">Use default (${esc(inherited)})</option>
      ${options.map(([v, t]) => `<option value="${esc(v)}" ${value === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}
    </select>
  </label>`;
}

function fileOptionsHtml(): string {
  const entry = activeEntry();
  if (!entry) return '';
  const part = state.partOptions.get(entry.file) ?? { copies: 1, mirror: false, overrides: {} };
  const resolved = resolvePartSettings(state.global, part, MATERIALS);
  const overrides = part.overrides;
  const profileOptions = PROFILES.map((p) => [p.id, `${p.name} — ${p.description}`] as [string, string]);
  const profileInherited = (() => {
    const p = getProfile(state.global.profile);
    return `${p.name} — ${p.description}`;
  })();
  const material = MATERIALS.find((m) => m.name.toLowerCase() === resolved.material.toLowerCase()) ?? getDefaultMaterial(MATERIALS);
  const colorOptions = material.colors.map((c) => [c.name, c.name] as [string, string]);
  const supportsOptions = SUPPORTS.map((s) => [s, supportLabel(s)] as [string, string]);
  const unitsOptions: Array<[string, string]> = [
    ['mm', 'Millimeters (mm)'],
    ['m', 'Meters (m)'],
    ['in', 'Inches (in)'],
  ];
  const noOverrides = Object.keys(overrides).length === 0;
  return `<fieldset class="file-options" aria-label="Selected file options">
  <legend>Options for <strong>${esc(entry.file.name)}</strong></legend>
  <div class="part-quick-controls">
    <label class="part-quick-control"><span>Copies</span>
      <select data-part="copies" aria-label="Number of copies">
        ${[1, 2, 3, 4, 5].map((v) => `<option value="${v}" ${v === part.copies ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </label>
    <label class="part-quick-control"><span>Mirror <small>X axis</small></span>
      <input class="mirror-switch" type="checkbox" role="switch" aria-label="Mirror along the X axis" data-part="mirror" ${part.mirror ? 'checked' : ''} />
    </label>
  </div>
  <details class="file-settings" ${state.moreSettingsOpen ? 'open' : ''}>
    <summary>More settings</summary>
    <div class="file-settings-body">
      <div class="part-override-heading">
        <span class="small muted">Only changes for this part.</span>
        <button type="button" class="text-button" data-action="reset-overrides" ${noOverrides ? 'disabled' : ''}>Reset to defaults</button>
      </div>
      <div class="field-grid part-settings-grid">
        ${overrideSelect('profile', 'Print profile', profileOptions, profileInherited)}
        ${overrideSelect('material', 'Material', MATERIALS.map((m) => [m.name, m.name] as [string, string]), state.global.material)}
        <div class="part-color-field">
          <label>Filament color
            <select data-override="color" aria-label="Filament color for this part">
              <option value="">Use default (${esc(state.global.color)})</option>
              ${colorOptions.map(([v, t]) => `<option value="${esc(v)}" ${overrides.color === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}
            </select>
          </label>
          <i class="swatch" aria-hidden="true" style="background-color: ${resolveColor(resolved.color, colorCode(resolved))}"></i>
        </div>
        ${overrideSelect('supports', 'Supports', supportsOptions, supportLabel(state.global.supports))}
        <label>Support overhang angle
          <span class="percent-input">
            <input data-override="supportAngle" aria-label="Support overhang angle (°)" type="number" min="0" max="90" step="1" placeholder="Default" value="${esc(overrides.supportAngle ?? '')}" />
            <span aria-hidden="true">°</span>
          </span>
          <span class="setting-inheritance">Higher angles add more support. Blank uses printer default.</span>
        </label>
        ${overrideSelect('units', 'Model units', unitsOptions, String(state.global.units))}
        <label>Scale
          <span class="percent-input">
            <input data-override="scalePercent" aria-label="Scale (%)" type="number" min="0.01" max="10000" step="any" placeholder="${esc(state.global.scalePercent)}" value="${esc(overrides.scalePercent ?? '')}" />
            <span aria-hidden="true">%</span>
          </span>
          <span class="setting-inheritance">Blank uses default (${esc(state.global.scalePercent)}%)</span>
        </label>
      </div>
    </div>
  </details>
</fieldset>`;
}

function renderReview() {
  const files = state.files;
  const totalCopies = files.reduce((sum, entry) => sum + (state.partOptions.get(entry.file)?.copies ?? 1), 0);
  $('#review-heading').textContent = files.length > 1 ? `Review your ${files.length} prints` : 'Review your print';
  const cards = files
    .map((entry, i) => {
      const part = resolvePartSettings(state.global, state.partOptions.get(entry.file), MATERIALS);
      const profile = getProfile(part.profile);
      const swatchHex = resolveColor(part.color, colorCode(part));
      const stem = entry.file.name.replace(/\.(stl|obj)$/i, '').trim() || `Part ${i + 1}`;
      const partTitle = files.length > 1 ? `${state.title.trim()} · ${stem}` : state.title.trim();
      const rot = state.orientations.get(entry.file) ?? DEFAULT_ROTATION;
      const isRotated = rot.some((val, idx) => Math.abs(val - (IDENTITY_ROTATION[idx] ?? 0)) > 1e-5);
      const angle = partSupportAngle(part);
      const dims = scaledDims(entry, part);
      const printer = dims.length ? selectPreviewPrinter(dims) : null;
      const fits = dims.length ? fitsPreviewPrinter(dims, printer!) : false;
      const dimsText = entry.dims ? entry.dims.min.map((v, j) => Number((entry.dims!.max[j] - v).toFixed(1))).join(' × ') + ' mm' : '';
      return `<div class="detail-card review-part-card ${i === state.activeIndex ? 'active' : ''}">
  <div class="review-part-header">
    <div class="review-part-heading">
      <h3>${esc(partTitle)}</h3>
      <span class="small muted">${esc(entry.file.name)} · ${formatMiB(entry.file.size)}${dimsText ? ` · ${esc(dimsText)}` : ''}</span>
    </div>
    ${files.length > 1 ? `<button type="button" class="button secondary review-preview-btn ${i === state.activeIndex ? 'is-active' : ''}" data-action="preview-part" data-index="${i}" aria-pressed="${i === state.activeIndex}">${i === state.activeIndex ? 'Previewing in 3D' : 'Preview in 3D'}</button>` : ''}
  </div>
  <dl class="settings-grid review-settings-grid">
    <div><dt>Print profile</dt><dd>${esc(profile.name)} · ${profile.layerHeight} mm · ${profile.walls} walls · ${profile.infill}% infill</dd></div>
    <div><dt>Material</dt><dd>${esc(part.material)}</dd></div>
    <div><dt>Filament</dt><dd><i class="swatch" style="background-color: ${swatchHex}"></i>${esc(part.color)}</dd></div>
    <div><dt>Supports</dt><dd>${esc(supportLabel(part.supports))}</dd></div>
    <div><dt>Support angle</dt><dd>${angle === null || angle === undefined ? 'Printer default' : `${angle}°`}</dd></div>
    <div><dt>Copies</dt><dd>${part.copies}</dd></div>
    <div><dt>Mirror X</dt><dd>${part.mirror ? 'Mirrored' : 'Normal'}</dd></div>
    <div><dt>Scale &amp; units</dt><dd class="review-value-text">${esc(part.scalePercent)}% (${esc(part.units)})</dd></div>
    <div><dt>Orientation</dt><dd>${isRotated ? 'Custom oriented' : 'Original'}</dd></div>
    <div><dt>Printer fit</dt><dd>${printer ? (fits ? `Fits ${esc(printer.name)}` : 'Too large for the largest bed') : 'Unknown'}</dd></div>
  </dl>
</div>`;
    })
    .join('');
  $('#review-content').innerHTML = `<div class="detail-card review-card">
  <h3>Submission details</h3>
  <dl class="settings-grid review-overview-grid">
    <div><dt>${files.length > 1 ? 'Batch / project title' : 'Part title'}</dt><dd class="review-value-text">${esc(state.title.trim())}</dd></div>
    <div><dt>Purdue email</dt><dd class="review-value-text"><span>${esc(state.email.trim().toLowerCase())}</span></dd></div>
    <div><dt>Total parts</dt><dd class="review-value-text">${files.length} ${files.length === 1 ? 'file' : 'files'} (${totalCopies} ${totalCopies === 1 ? 'copy' : 'copies'})</dd></div>
  </dl>
  ${state.notes.trim() ? `<div class="review-notes-block"><span class="review-notes-label">Operator notes</span><p class="operator-notes">${esc(state.notes.trim())}</p></div>` : ''}
</div>
<div class="review-parts-list" aria-label="Parts to submit">${cards}</div>`;
}

/** Cache the receipt locally for the My prints page. */
function rememberSubmittedPrint(id: string): void {
  const first = state.files[0];
  const part = resolvePartSettings(state.global, first ? state.partOptions.get(first.file) : undefined, MATERIALS);
  const print: MyPrint = {
    title: state.title.trim(),
    ref: id,
    email: state.email.trim().toLowerCase(),
    profileName: getProfile(part.profile).name,
    material: part.material,
    color: part.color,
    printer: 'Pending printer assignment',
    estTime: '—',
    status: 'submitted',
    progress: 0,
    queuePosition: 0,
    startedAt: '',
    estReady: '',
    finishedAt: '',
    cubby: '',
    submittedAt: Date.now(),
  };
  saveMyPrints([...loadMyPrints().filter((item) => item.ref !== id), print]);
}

function renderReceipt(id: string) {
  const files = state.files;
  const totalCopies = files.reduce((sum, entry) => sum + (state.partOptions.get(entry.file)?.copies ?? 1), 0);
  rememberSubmittedPrint(id);
  $('#step-receipt').innerHTML = `<div class="receipt">
  <h2>Print request received</h2>
  <p>We saved <strong>${esc(state.title.trim())}</strong> (${files.length} ${files.length === 1 ? 'file' : 'files'}, ${totalCopies} ${totalCopies === 1 ? 'copy' : 'copies'}).</p>
  <p>Submission ID <strong>${esc(id)}</strong></p>
  <a href="/my-prints" class="button primary">View my print</a>
  <a href="/" class="button secondary">Back to queue</a>
  <button type="button" class="text-button" id="another-button">Submit another print</button>
</div>`;
  $('#another-button').addEventListener('click', () => resetFlow());
}

function resetFlow() {
  state.files = [];
  state.activeIndex = 0;
  state.fileOptionsOpen = true;
  state.moreSettingsOpen = false;
  state.orientations = new Map();
  state.partOptions = new Map();
  state.title = '';
  state.notes = '';
  state.email = '';
  state.step = 'details';
  state.busy = false;
  submissionId = null;
  ($('#part-title') as HTMLInputElement).value = '';
  ($('#operator-notes') as HTMLTextAreaElement).value = '';
  ($('#email') as HTMLInputElement).value = '';
  $('#upload-progress').hidden = true;
  setSubmitButtons(false);
  showStep('details');
  clearMessages();
  renderFileList();
  updateDropZone();
  pushPreview();
}

function showStep(step: 'details' | 'review' | 'done') {
  state.step = step;
  $('#step-details').hidden = step !== 'details';
  $('#step-review').hidden = step !== 'review';
  $('#step-receipt').hidden = step !== 'done';
  window.scrollTo?.({ top: 0, behavior: 'smooth' });
}

// ---------- validation & submit ----------

function revealFile(index: number) {
  state.activeIndex = index;
  state.fileOptionsOpen = true;
  state.moreSettingsOpen = true;
  renderFileList();
}

async function toReview(): Promise<boolean> {
  clearMessages();
  // Wait for any in-flight model parses so entry.dims / entry.parseError are
  // settled before validating — an unreadable or still-parsing file must not
  // slip past the printer-fit check.
  if (state.files.some((entry) => !entry.dims && !entry.parseError)) setFormMessage('Reading your model files…');
  await Promise.all(state.files.map((entry) => entry.parsePromise ?? Promise.resolve()));
  clearMessages();
  const files = state.files.map((entry) => entry.file);
  const invalid = validateFiles(files);
  if (!invalid.ok) {
    setFileMessage(invalid.error);
    return false;
  }
  const unreadable = state.files.find((entry) => entry.parseError);
  if (unreadable) {
    setFileMessage(`${unreadable.file.name}: ${unreadable.parseError}`);
    return false;
  }
  for (let i = 0; i < state.files.length; i++) {
    const entry = state.files[i];
    const part = resolvePartSettings(state.global, state.partOptions.get(entry.file), MATERIALS);
    if (partScale(part) === null) {
      revealFile(i);
      setFormMessage(`Enter a scale between 0.01% and 10000% for ${entry.file.name}.`);
      flagInvalid(document.querySelector(`#file-options-${i} [data-override="scalePercent"]`));
      return false;
    }
    if (partSupportAngle(part) === null) {
      revealFile(i);
      setFormMessage(`Enter a whole-number support angle from 0° to 90° for ${entry.file.name}.`);
      flagInvalid(document.querySelector(`#file-options-${i} [data-override="supportAngle"]`));
      return false;
    }
    const dims = scaledDims(entry, part);
    if (entry.dims && dims.length && !fitsAnyPrinter(dims)) {
      setFormMessage(`${entry.file.name} is too large for every available printer (max ${LARGEST_BED}). Scale it down or lay it on a face.`);
      flagInvalid(document.querySelector(`#file-options-${i}`));
      return false;
    }
  }
  if (!state.title.trim()) {
    $('#title-message').textContent = 'Enter a part title to continue.';
    flagInvalid($('#part-title'));
    return false;
  }
  const email = state.email.trim().toLowerCase();
  if (!/^[^@\s]+@purdue\.edu$/.test(email)) {
    $('#email-message').textContent = 'Enter a Purdue email (you@purdue.edu).';
    flagInvalid($('#email'));
    return false;
  }
  renderReview();
  showStep('review');
  pushPreview();
  return true;
}

function setSubmitButtons(busy: boolean) {
  ($('#confirm-button') as HTMLButtonElement).disabled = busy;
  ($('#back-button') as HTMLButtonElement).disabled = busy;
  ($('#edit-button') as HTMLButtonElement).disabled = busy;
  $('#cancel-button').hidden = !busy;
}

function submissionForm(id: string): FormData {
  const parts = state.files.map(({ file }) => {
    const settings = resolvePartSettings(state.global, state.partOptions.get(file), MATERIALS);
    return {
      ...settings,
      scalePercent: Number(settings.scalePercent),
      supportAngle: partSupportAngle(settings) ?? null,
      rotation: state.orientations.get(file) ?? DEFAULT_ROTATION,
    };
  });
  const form = new FormData();
  form.set('submission', JSON.stringify({
    id,
    title: state.title.trim(),
    email: state.email.trim().toLowerCase(),
    notes: state.notes.trim(),
    parts,
  }));
  for (const { file } of state.files) form.append('models', file);
  return form;
}

function startSubmit() {
  if (state.busy) return;
  const api = (import.meta.env.PUBLIC_PRINT_API_URL ?? (import.meta.env.DEV ? 'http://127.0.0.1:8000' : '')).replace(/\/$/, '');
  const id = submissionId ??= crypto.randomUUID();
  const request = new XMLHttpRequest();
  request.open('POST', `${api}/api/prints`);
  request.responseType = 'json';
  activeUpload = request;
  state.busy = true;
  clearMessages();
  setSubmitButtons(true);

  const progress = $('#upload-progress');
  const bar = $('#upload-progress-bar') as HTMLProgressElement;
  const text = $('#upload-progress-text');
  progress.hidden = false;
  bar.removeAttribute('value');
  text.textContent = 'Uploading your models…';

  const complete = (message?: string) => {
    activeUpload = null;
    state.busy = false;
    progress.hidden = true;
    setSubmitButtons(false);
    if (message) setFormMessage(message);
  };

  request.upload.onprogress = (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.round((event.loaded / event.total) * 100);
    bar.value = percent;
    text.textContent = `Uploading your models… ${percent}%`;
  };
  request.upload.onload = () => {
    bar.removeAttribute('value');
    text.textContent = 'Saving your print request…';
  };
  request.onload = () => {
    const receipt = request.response;
    if (request.status === 201 && receipt?.id === id && receipt?.status === 'submitted') {
      complete();
      renderReceipt(id);
      showStep('done');
      pushPreview();
      return;
    }
    complete(typeof receipt?.detail === 'string' ? receipt.detail : 'Unable to save your print request. Try again.');
  };
  request.onerror = () => complete('The print server could not confirm this request. Try again.');
  request.onabort = () => complete('Upload stopped. Submit again to confirm whether the request was saved.');
  request.send(submissionForm(id));
}

// ---------- global settings ----------

function rebuildColorOptions() {
  const material = MATERIALS.find((m) => m.name.toLowerCase() === state.global.material.toLowerCase()) ?? getDefaultMaterial(MATERIALS);
  const select = $('#setting-color') as HTMLSelectElement;
  select.innerHTML = material.colors
    .map((c) => `<option value="${esc(c.name)}" ${c.name === state.global.color ? 'selected' : ''}>${esc(c.name)}</option>`)
    .join('');
  updateSwatch();
}

function updateSwatch() {
  const material = MATERIALS.find((m) => m.name.toLowerCase() === state.global.material.toLowerCase());
  const code = material?.colors.find((c) => c.name.toLowerCase() === state.global.color.toLowerCase())?.code;
  ($('#color-swatch') as HTMLElement).style.backgroundColor = resolveColor(state.global.color, code);
}

function updateGlobalSettings(change: Partial<SharedPartSettings>) {
  const next = { ...state.global, ...change };
  if (change.material !== undefined && change.color === undefined && change.material.toLowerCase() !== state.global.material.toLowerCase()) {
    const target = MATERIALS.find((m) => m.name.toLowerCase() === change.material!.toLowerCase()) ?? getDefaultMaterial(MATERIALS);
    next.color = getDefaultColor(target);
  }
  const resolved = resolvePartSettings(next, undefined, MATERIALS);
  next.material = resolved.material;
  next.color = resolved.color;
  state.global = next;
  state.partOptions = new Map(
    [...state.partOptions].map(([file, part]) => [
      file,
      { ...part, overrides: normalizePartOverrides(next, part.overrides, MATERIALS) },
    ]),
  );
  rebuildColorOptions();
  renderFileList();
  pushPreview();
}

// ---------- init ----------

export function initSubmitFlow() {
  const form = $('#submission-form') as HTMLFormElement;
  const titleInput = $('#part-title') as HTMLInputElement;
  const emailInput = $('#email') as HTMLInputElement;
  const notesInput = $('#operator-notes') as HTMLTextAreaElement;
  const fileInput = $('#model-file') as HTMLInputElement;
  const dropZone = $('#drop-zone');

  preview = new PrintPreview($('#preview-root'), {
    onRotationChange: (rotation) => {
      const entry = activeEntry();
      if (entry) {
        state.orientations.set(entry.file, rotation);
        // re-measure under the new orientation so fit checks and summaries use rotated dims
        void parseDims(entry).then(() => {
          renderFileList();
          if (state.step === 'review') renderReview();
        });
      }
      pushPreview();
      if (state.step === 'review') renderReview();
    },
    onUseMeters: () => {
      const entry = activeEntry();
      if (!entry) return;
      const part = state.partOptions.get(entry.file) ?? { copies: 1, mirror: false, overrides: {} };
      state.partOptions.set(entry.file, {
        ...part,
        overrides: normalizePartOverrides(state.global, { ...part.overrides, units: 'm' }, MATERIALS),
      });
      renderFileList();
      pushPreview();
    },
  });

  // file intake
  fileInput.addEventListener('change', () => {
    void addFiles(Array.from(fileInput.files ?? []));
    fileInput.value = '';
  });
  dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('is-dragging');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-dragging'));
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('is-dragging');
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    void addFiles(files);
  });
  $('#clear-files').addEventListener('click', () => {
    state.files = [];
    state.orientations = new Map();
    state.partOptions = new Map();
    state.activeIndex = 0;
    clearFileMessage();
    renderFileList();
    updateDropZone();
    pushPreview();
  });

  // delegated actions inside the dynamic file list / options / review
  form.addEventListener('click', (event) => {
    const summary = (event.target as HTMLElement).closest('details.file-settings > summary');
    if (summary) {
      const details = summary.parentElement as HTMLDetailsElement;
      queueMicrotask(() => {
        state.moreSettingsOpen = details.open;
      });
    }
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const index = Number(target.dataset.index ?? -1);
    if (action === 'select-file' && index >= 0) {
      state.fileOptionsOpen = index === state.activeIndex ? !state.fileOptionsOpen : true;
      state.activeIndex = index;
      renderFileList();
      pushPreview();
    } else if (action === 'remove-file' && index >= 0) {
      removeFileAt(index);
    } else if (action === 'reset-overrides') {
      const entry = activeEntry();
      if (!entry) return;
      const part = state.partOptions.get(entry.file);
      state.partOptions.set(entry.file, { copies: part?.copies ?? 1, mirror: part?.mirror ?? false, overrides: {} });
      renderFileList();
      pushPreview();
    } else if (action === 'preview-part' && index >= 0) {
      state.activeIndex = index;
      renderReview();
      pushPreview();
    }
  });

  form.addEventListener('change', (event) => {
    const target = event.target as HTMLElement;
    const overrideEl = target.closest<HTMLElement>('[data-override]');
    if (overrideEl) {
      const entry = activeEntry();
      if (!entry) return;
      const key = overrideEl.dataset.override as keyof SharedPartSettings;
      const value = (overrideEl as HTMLSelectElement | HTMLInputElement).value;
      const part = state.partOptions.get(entry.file) ?? { copies: 1, mirror: false, overrides: {} };
      const overrides = { ...part.overrides };
      if (value === '') delete overrides[key];
      else overrides[key] = value as never;
      state.partOptions.set(entry.file, {
        ...part,
        overrides: normalizePartOverrides(state.global, overrides, MATERIALS),
      });
      renderFileList();
      pushPreview();
      return;
    }
    const partEl = target.closest<HTMLElement>('[data-part]');
    if (partEl) {
      const entry = activeEntry();
      if (!entry) return;
      const part = state.partOptions.get(entry.file) ?? { copies: 1, mirror: false, overrides: {} };
      if (partEl.dataset.part === 'copies') state.partOptions.set(entry.file, { ...part, copies: Number((partEl as HTMLSelectElement).value) });
      else if (partEl.dataset.part === 'mirror') state.partOptions.set(entry.file, { ...part, mirror: (partEl as HTMLInputElement).checked });
      renderFileList();
      pushPreview();
    }
  });

  // global default settings
  $('#setting-profile').addEventListener('change', (event) => updateGlobalSettings({ profile: (event.target as HTMLSelectElement).value }));
  $('#setting-material').addEventListener('change', (event) => updateGlobalSettings({ material: (event.target as HTMLSelectElement).value }));
  $('#setting-color').addEventListener('change', (event) => updateGlobalSettings({ color: (event.target as HTMLSelectElement).value }));
  $('#setting-supports').addEventListener('change', (event) => updateGlobalSettings({ supports: (event.target as HTMLSelectElement).value }));
  $('#setting-units').addEventListener('change', (event) => updateGlobalSettings({ units: (event.target as HTMLSelectElement).value as SharedPartSettings['units'] }));
  $('#setting-scale').addEventListener('input', (event) => updateGlobalSettings({ scalePercent: (event.target as HTMLInputElement).value }));

  titleInput.addEventListener('input', () => {
    state.title = titleInput.value;
    if (titleInput.value.trim()) {
      $('#title-message').textContent = '';
      unflag(titleInput);
    }
  });
  titleInput.addEventListener('blur', () => {
    if (!titleInput.value.trim()) $('#title-message').textContent = 'Enter a part title to continue.';
  });
  emailInput.addEventListener('input', () => {
    state.email = emailInput.value.toLowerCase();
    if (state.email.trim()) {
      $('#email-message').textContent = '';
      unflag(emailInput);
    }
  });
  // editing any field clears its red error outline
  form.addEventListener('input', (event) => unflag(event.target as HTMLElement));
  form.addEventListener('change', (event) => unflag(event.target as HTMLElement));
  notesInput.addEventListener('input', () => {
    state.notes = notesInput.value;
  });

  // step navigation
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.step === 'details') void toReview();
    else if (state.step === 'review') startSubmit();
  });
  $('#edit-button').addEventListener('click', () => {
    if (state.busy) return;
    submissionId = null;
    clearMessages();
    showStep('details');
    pushPreview();
  });
  $('#back-button').addEventListener('click', () => {
    if (state.busy) return;
    submissionId = null;
    clearMessages();
    showStep('details');
    pushPreview();
  });
  $('#cancel-button').addEventListener('click', () => activeUpload?.abort());

  // initial paint
  rebuildColorOptions();
  renderFileList();
  updateDropZone();
  pushPreview();
}
