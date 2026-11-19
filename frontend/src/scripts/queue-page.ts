/**
 * My prints page (/my-prints) — Final Design screens S5 (Submitted · My
 * print queued), S6 (My print · Printing) and S7 (My print · Ready for
 * pickup).
 *
 * The submit flow appends every submitted print to localStorage under
 * `printhive:myPrints`; this script lists them as clickable "My prints"
 * rows (the page shows only your own prints), and shows the selected
 * print's banner plus inspector panel (status steps, why/slicing/pickup
 * boxes). Purple dashed demo buttons advance the selected print
 * queued → printing → ready so the Figma screens can be previewed without
 * a backend.
 */

export type MyPrintStatus = 'submitted' | 'queued' | 'printing' | 'ready' | 'canceled';

export interface MyPrint {
	title: string;
	ref: string;
	email: string;
	profileName: string;
	material: string;
	color: string;
	printer: string;
	estTime: string;
	status: MyPrintStatus;
	progress: number;
	queuePosition: number;
	startedAt: string;
	estReady: string;
	finishedAt: string;
	cubby: string;
	submittedAt: number;
}

export const MY_PRINTS_STORAGE_KEY = 'printhive:myPrints';
const LEGACY_STORAGE_KEY = 'printhive:myPrint';

export function loadMyPrints(): MyPrint[] {
	try {
		const raw = localStorage.getItem(MY_PRINTS_STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		const list = Array.isArray(parsed) ? parsed : [parsed];
		return list.filter(
			(p): p is MyPrint => Boolean(p && typeof p === 'object' && typeof p.title === 'string' && typeof p.status === 'string'),
		);
	} catch {
		return [];
	}
}

export function saveMyPrints(prints: MyPrint[]): void {
	try {
		localStorage.setItem(MY_PRINTS_STORAGE_KEY, JSON.stringify(prints));
	} catch {
		/* storage unavailable — the demo still works for this page view */
	}
}

function esc(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function $(id: string): HTMLElement {
	const el = document.getElementById(id);
	if (!el) throw new Error(`#${id} missing`);
	return el;
}

// ---------- my prints rows (clickable) ----------

type BadgeTone = 'green' | 'yellow' | 'amber' | 'gray';

function myPrintBadges(print: MyPrint): { text: string; tone: BadgeTone }[] {
	switch (print.status) {
		case 'submitted':
			return [{ text: 'Submitted', tone: 'green' }];
		case 'printing':
			return [
				{ text: 'Printing', tone: 'amber' },
				{ text: 'YOUR PRINT', tone: 'yellow' },
			];
		case 'ready':
			return [{ text: '✓ Ready', tone: 'green' }];
		case 'canceled':
			return [{ text: 'Canceled', tone: 'gray' }];
		default:
			return [
				{ text: `Starts ~${print.estReady.replace(/^~/, '')}` , tone: 'green' },
				{ text: 'YOUR PRINT', tone: 'yellow' },
			];
	}
}

function myPrintMeta(print: MyPrint): string {
	switch (print.status) {
		case 'submitted':
			return `${print.material} ${print.color} · ${print.profileName}`;
		case 'ready':
			return `Finished ${print.finishedAt} on ${print.printer} · Plate cleared by attendant · ${print.cubby}`;
		case 'printing':
			return `${print.printer} · ${print.material} ${print.color} · Est. ready ${print.estReady}`;
		case 'canceled':
			return `${print.printer} · ${print.material} ${print.color} · Request canceled`;
		default:
			return `${print.printer} · ${print.material} ${print.color} · Est. ready ${print.estReady}`;
	}
}

function renderMyPrintRow(print: MyPrint, selectedId: string | null): string {
	const badges = myPrintBadges(print).map((b) => `<span class="badge badge-${b.tone}">${esc(b.text)}</span>`).join('');
	const classes = ['job-row', 'yours'];
	if (print.status === 'ready') classes.push('ready');
	const side = print.status === 'printing'
		? `<div class="job-side"><div class="job-progress"><div class="progress-track" role="img" aria-label="${print.progress}% complete"><span style="width:${print.progress}%"></span></div><span class="job-pct">${print.progress}%</span></div></div>`
		: `<div class="job-side"><span class="details-link">Details ›</span></div>`;
	return `<button type="button" class="${classes.join(' ')}" data-print-ref="${esc(print.ref)}" aria-pressed="${print.ref === selectedId}">
  <div class="job-badges">${badges}</div>
  <div class="job-info">
    <p class="job-title">${esc(print.title)} · ${esc(print.ref)}</p>
    <p class="job-meta${print.status === 'ready' ? ' green' : ''}">${esc(myPrintMeta(print))}</p>
  </div>
  ${side}
</button>`;
}

function renderMyPrintsSection(prints: MyPrint[], selectedId: string | null): string {
	return `<section class="queue-section" aria-label="My prints">
  <div class="section-head"><h2>My prints</h2><span class="count-chip">${prints.length}</span></div>
  <div class="job-list">${prints.map((p) => renderMyPrintRow(p, selectedId)).join('')}</div>
</section>`;
}

// ---------- banner + inspector panel (S5/S6/S7) ----------

function renderBanner(print: MyPrint): string {
	switch (print.status) {
		case 'submitted':
			return `<div class="banner banner-green" role="status">The print server received “${esc(print.title)}”.</div>`;
		case 'printing':
			return `<div class="banner banner-neutral" role="status">Your print started at ${esc(print.startedAt)} on ${esc(print.printer)}.</div>`;
		case 'ready':
			return `<div class="banner banner-green" role="status">Your print “${esc(print.title)}” is ready for pickup at The Hive — ${esc(print.cubby)}.</div>`;
		case 'canceled':
			return `<div class="banner banner-red" role="status">Your print request for “${esc(print.title)}” was canceled. You can submit it again any time.</div>`;
		default:
			return `<div class="banner banner-green" role="status">✓ Email confirmed — “${esc(print.title)}” was added to the queue. Updates will be emailed to ${esc(print.email)}.</div>`;
	}
}

const STEP_LABELS = ['Confirmed', 'Sliced', 'Queued', 'Printing', 'Ready'];

function renderSteps(current: number, canceled = false): string {
	// current = index of the in-progress step (-2 when all done)
	const items: string[] = [];
	STEP_LABELS.forEach((label, i) => {
		if (i > 0) items.push(`<li class="step-connector${current === -2 || i <= current ? ' done' : ''}" aria-hidden="true"></li>`);
		let cls = 'step';
		let circle = `${i + 1}`;
		if (i < current || current === -2) {
			cls += ' done';
			circle = '✓';
		} else if (i === current) {
			cls += canceled ? ' canceled' : ' current';
			if (canceled) circle = '✕';
		}
		items.push(`<li class="${cls}"><span class="step-circle">${circle}</span><span class="step-label">${label}</span></li>`);
	});
	return `<ol class="steps">${items.join('')}</ol>`;
}

function statusBadge(print: MyPrint): string {
	switch (print.status) {
		case 'submitted':
			return '<span class="badge badge-green">Submitted</span>';
		case 'printing':
			return `<span class="badge badge-amber">Printing · ${print.progress}%</span>`;
		case 'ready':
			return `<span class="badge badge-green">✓ Ready for pickup</span>`;
		case 'canceled':
			return `<span class="badge badge-gray" style="background:var(--red-soft);color:var(--red)">Canceled</span>`;
		default:
			return `<span class="badge badge-green">Queued · #${print.queuePosition}</span>`;
	}
}

function renderPanelBody(print: MyPrint): string {
	if (print.status === 'submitted') {
		return '<p class="panel-note">Your files and print settings have been saved. Live print status is currently unavailable.</p>';
	}
	if (print.status === 'printing') {
		return `${renderSteps(3)}
<div class="camera" aria-label="Live camera placeholder">
  <span class="camera-label">Live camera · ${esc(print.printer)}</span>
  <span class="camera-live">● LIVE</span>
  <span class="camera-rect-a" aria-hidden="true"></span>
  <span class="camera-rect-b" aria-hidden="true"></span>
</div>
<div class="telemetry">
  <div class="tele-card"><span>Progress</span><strong>${print.progress}%</strong></div>
  <div class="tele-card"><span>Nozzle</span><strong>220°C</strong></div>
  <div class="tele-card"><span>Bed</span><strong>65°C</strong></div>
  <div class="tele-card"><span>Est. ready</span><strong>${esc(print.estReady)}</strong></div>
</div>
<p class="panel-note">Printer status updates every 10 seconds. You’ll get an email when your print is ready.</p>
<button type="button" class="button demo" disabled title="The attendant (operator) screens are out of scope for this prototype">Demo: print finishes → see the attendant’s screen</button>
<button type="button" class="button demo" data-action="demo-ready">Demo: skip to “ready for pickup”</button>`;
	}
	if (print.status === 'ready') {
		return `${renderSteps(-2)}
<div class="pickup-box">
  <p class="box-title">Where to pick up your part</p>
  <p>• Location: The Hive — 3D print pickup shelf, ${esc(print.cubby)}</p>
  <p>• Your bag is tagged ${esc(print.ref)} (${esc(print.email)})</p>
  <p>• Print time: ${esc(print.estTime)} · ${esc(print.material)} ${esc(print.color)}</p>
</div>
<div class="panel-actions">
  <a class="button primary" href="/submit">Submit another print</a>
  <a class="button secondary" href="/">Back to queue</a>
</div>
<p class="panel-note">End of the student flow. Restart from “Queue (home)”.</p>`;
	}
	if (print.status === 'canceled') {
		return `${renderSteps(2, true)}
<div class="slice-box">
  <p class="box-title">Print request canceled</p>
  <p>“${esc(print.title)}” ${esc(print.ref)} was removed from the queue. Nothing was printed and no charge applies.</p>
</div>
<div class="panel-actions">
  <a class="button primary" href="/submit">Submit another print</a>
  <a class="button secondary" href="/">Back to queue</a>
</div>`;
	}
	return `${renderSteps(2)}
<div class="why-box">
  <p class="box-title">Why your print is in this spot</p>
  <p>• Shares a build plate with “Cable clip ×2” — both are ${esc(print.material)} ${esc(print.color)}, so they print together (FR-11).</p>
  <p>• Est. finish ${esc(print.estReady)} is inside the 2–6 PM staffed shift, so an attendant can remove it (FR-10).</p>
  <p>• Order uses each job’s priority plus time waiting in the queue (FR-17).</p>
</div>
<div class="slice-box">
  <p class="box-title">Slicing result</p>
  <p>Sliced on the server with Orca Slicer · ${esc(print.profileName)} profile</p>
  <p>Est. print time ${esc(print.estTime)} · ${esc(print.material)} ${esc(print.color)} (FR-07, FR-08)</p>
</div>
<div class="panel-actions">
  <button type="button" class="button danger" data-action="cancel-print">Cancel print request</button>
  <a class="button secondary" href="/">Back to queue</a>
</div>
<button type="button" class="button demo" data-action="demo-printing">Demo: print starts →</button>`;
}

function renderMyPrintPanel(print: MyPrint): string {
	return `<p class="panel-label">MY PRINT</p>
<div class="panel-title-row">
  <h2 class="panel-title">${esc(print.title)} · ${esc(print.ref)}</h2>
  ${statusBadge(print)}
</div>
${renderPanelBody(print)}`;
}

function renderEmptyPanel(): string {
	return `<p class="panel-label">MY PRINT</p>
<div class="panel-title-row"><h2 class="panel-title">No print yet</h2></div>
<div class="slice-box">
  <p class="box-title">Nothing in your queue</p>
  <p>Submit a print and it will show up here — queued, then printing, then ready for pickup.</p>
</div>
<div class="panel-actions">
  <a class="button primary" href="/submit">Submit a print</a>
  <a class="button secondary" href="/">Back to queue</a>
</div>`;
}

// ---------- state ----------

let selectedRef: string | null = null;

function advance(prints: MyPrint[], ref: string, patch: Partial<MyPrint>): void {
	const next = prints.map((p) => (p.ref === ref ? { ...p, ...patch } : p));
	saveMyPrints(next);
	selectedRef = ref;
	render(next);
}

function render(prints: MyPrint[]): void {
	if (!selectedRef || !prints.some((p) => p.ref === selectedRef)) {
		selectedRef = prints.length ? prints[prints.length - 1]!.ref : null;
	}
	const selected = prints.find((p) => p.ref === selectedRef) ?? null;

	const banner = $('queue-banner');
	if (selected) {
		banner.innerHTML = renderBanner(selected);
		banner.hidden = false;
	} else {
		banner.hidden = true;
	}

	$('queue-main').innerHTML =
		(prints.length
			? renderMyPrintsSection(prints, selectedRef)
			: `<section class="queue-section" aria-label="My prints">
  <div class="section-head"><h2>My prints</h2><span class="count-chip">0</span></div>
  <div class="job-list"><div class="job-row"><div class="job-info">
    <p class="job-title">No prints yet</p>
    <p class="job-meta">Submit a print from the queue page and it will appear here.</p>
  </div></div></div>
</section>`) +
		`<p class="queue-note">Updates every 15 seconds. Select one of your prints to inspect it.</p>`;

	const panel = $('my-print');
	panel.innerHTML = selected ? renderMyPrintPanel(selected) : renderEmptyPanel();

	document.querySelectorAll<HTMLElement>('#queue-main .job-row[data-print-ref]').forEach((row) => {
		row.addEventListener('click', () => {
			selectedRef = row.dataset.printRef ?? null;
			render(prints);
		});
	});
	if (selected) {
		panel.querySelector('[data-action="demo-printing"]')?.addEventListener('click', () =>
			advance(prints, selected.ref, { status: 'printing', progress: 45, startedAt: '2:31 PM', estReady: estReadyFromNow(selected) }),
		);
		panel.querySelector('[data-action="demo-ready"]')?.addEventListener('click', () =>
			advance(prints, selected.ref, { status: 'ready', progress: 100, finishedAt: '4:43 PM', cubby: 'Cubby B-04' }),
		);
		panel.querySelector('[data-action="cancel-print"]')?.addEventListener('click', () => advance(prints, selected.ref, { status: 'canceled' }));
	}
}

/** Parse a `formatEstTime` string ("45 min", "2 h", "2 h 15 m") into minutes; null when unrecognized. */
export function parseEstMinutes(estTime: string): number | null {
	const hours = /(\d+)\s*h(?:\s*(\d+)\s*m)?/.exec(estTime);
	if (hours) return Number(hours[1]) * 60 + Number(hours[2] ?? 0);
	const mins = /(\d+)\s*min/.exec(estTime);
	if (mins) return Number(mins[1]);
	return null;
}

function estReadyFromNow(print: MyPrint): string {
	// ~est. print time from now, formatted like the queue ETAs (e.g. ~4:45 PM)
	const minutes = parseEstMinutes(print.estTime) ?? 2 * 60 + 15; // fallback: 2 h 15 m
	const ready = new Date(Date.now() + minutes * 60_000);
	let h = ready.getHours() % 12;
	if (h === 0) h = 12;
	const ampm = ready.getHours() >= 12 ? 'PM' : 'AM';
	return `~${h}:${String(ready.getMinutes()).padStart(2, '0')} ${ampm}`;
}

function init(): void {
	if (typeof document === 'undefined' || !document.getElementById('my-print')) return; // not the my-prints page (e.g. imported by /submit)
	render(loadMyPrints());
}

init();
