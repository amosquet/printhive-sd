/**
 * Queue home enhancement — Final Design screens S5 (Submitted · My print
 * queued), S6 (My print · Printing) and S7 (My print · Ready for pickup).
 *
 * The submit flow stores the submitted print in localStorage under
 * `printhive:myPrint`; this script renders the matching banner, queue rows
 * and "MY PRINT" inspector panel. Purple dashed demo buttons advance the
 * state (queued → printing → ready) so the Figma screens can be previewed
 * without a backend. Without a stored print the server-rendered S0 queue
 * is left untouched.
 */

export type MyPrintStatus = 'queued' | 'printing' | 'ready' | 'canceled';

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

export const MY_PRINT_STORAGE_KEY = 'printhive:myPrint';

export function loadMyPrint(): MyPrint | null {
	try {
		const raw = localStorage.getItem(MY_PRINT_STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<MyPrint>;
		if (!parsed || typeof parsed.title !== 'string' || typeof parsed.status !== 'string') return null;
		return { ...defaultPrint(), ...parsed };
	} catch {
		return null;
	}
}

export function saveMyPrint(print: MyPrint): void {
	try {
		localStorage.setItem(MY_PRINT_STORAGE_KEY, JSON.stringify(print));
	} catch {
		/* storage unavailable — the demo still works for this page view */
	}
}

function defaultPrint(): MyPrint {
	return {
		title: '',
		ref: '',
		email: '',
		profileName: 'Standard',
		material: 'PLA',
		color: 'black',
		printer: 'Bambu H2D Pro',
		estTime: '—',
		status: 'queued',
		progress: 0,
		queuePosition: 1,
		startedAt: '',
		estReady: '',
		finishedAt: '',
		cubby: '',
		submittedAt: Date.now(),
	};
}

function esc(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function $(id: string): HTMLElement {
	const el = document.getElementById(id);
	if (!el) throw new Error(`#${id} missing`);
	return el;
}

// ---------- sample queue (Figma S0/S5/S6/S7 rows) ----------

type BadgeTone = 'green' | 'yellow' | 'amber' | 'gray';
interface QueueJob {
	badges: { text: string; tone: BadgeTone }[];
	title: string;
	meta: string;
	metaGreen?: boolean;
	progress?: number;
	yours?: boolean;
	ready?: boolean;
	why?: string;
	details?: boolean;
}
interface QueueSection {
	name: string;
	jobs: QueueJob[];
}

function sectionsFor(print: MyPrint): QueueSection[] {
	const yoursTitle = `${print.title} · ${print.ref}`;
	switch (print.status) {
		case 'printing':
			return [
				{
					name: 'Printing',
					jobs: [
						{
							badges: [
								{ text: 'Printing', tone: 'amber' },
								{ text: 'YOUR PRINT', tone: 'yellow' },
							],
							title: yoursTitle,
							meta: `${print.printer} · ${print.material} ${print.color} · Est. ready ${print.estReady}`,
							progress: print.progress,
							yours: true,
						},
						{
							badges: [{ text: 'Printing', tone: 'amber' }],
							title: 'Bracket v2',
							meta: 'Prusa Core ONE+ · PLA white · Est. ready ~4:55 PM',
							progress: 88,
						},
					],
				},
				{
					name: 'Queued',
					jobs: [
						{
							badges: [{ text: 'After plate clear', tone: 'gray' }],
							title: 'Drone arm ×3',
							meta: 'Bambu H2D Pro · PLA black',
						},
						{
							badges: [{ text: 'Overnight', tone: 'gray' }],
							title: 'Enclosure lid (est. 9 h 10 m)',
							meta: 'Prusa Core ONE+ · PETG black',
						},
					],
				},
			];
		case 'ready':
			return [
				{
					name: 'Ready for pickup',
					jobs: [
						{
							badges: [{ text: '✓ Ready', tone: 'green' }],
							title: yoursTitle,
							meta: `Finished ${print.finishedAt} on ${print.printer} · Plate cleared by attendant · ${print.cubby}`,
							metaGreen: true,
							ready: true,
						},
					],
				},
				{
					name: 'Printing',
					jobs: [
						{
							badges: [{ text: 'Printing', tone: 'amber' }],
							title: 'Drone arm ×3',
							meta: 'Bambu H2D Pro · PLA black · Est. ready ~5:50 PM',
							progress: 4,
						},
						{
							badges: [{ text: 'Printing', tone: 'amber' }],
							title: 'Bracket v2',
							meta: 'Prusa Core ONE+ · PLA white',
							progress: 98,
						},
					],
				},
			];
		case 'canceled':
			return [
				{
					name: 'Printing',
					jobs: [
						{
							badges: [{ text: 'Printing', tone: 'amber' }],
							title: 'Bracket v2',
							meta: 'Prusa Core ONE+ · PLA white · Est. ready ~4:55 PM',
							progress: 62,
						},
					],
				},
				{
					name: 'Queued',
					jobs: [
						{
							badges: [{ text: 'Starts ~2:30 PM', tone: 'green' }],
							title: 'Cable clip ×2',
							meta: 'Bambu H2D Pro · PLA black · Plate open for other PLA black parts',
							why: 'Why here? Other PLA black parts can still join this build plate (FR-11), and it finishes before the 6:00 PM shift ends (FR-10).',
							details: true,
						},
						{
							badges: [{ text: 'Waiting · overnight', tone: 'gray' }],
							title: 'Enclosure lid (est. 9 h 10 m)',
							meta: 'Prusa Core ONE+ · PETG black · Submitted 1 h ago',
							why: 'Why later? Too long to finish within today’s staffed shift, so it waits for the overnight window (FR-10). Waiting time raises its priority (FR-17).',
							details: true,
						},
					],
				},
			];
		default:
			return [
				{
					name: 'Printing',
					jobs: [
						{
							badges: [{ text: 'Printing', tone: 'amber' }],
							title: 'Bracket v2',
							meta: 'Prusa Core ONE+ · PLA white · Est. ready ~4:55 PM',
							progress: 62,
						},
					],
				},
				{
					name: 'Queued',
					jobs: [
						{
							badges: [
								{ text: 'Starts ~2:30 PM', tone: 'green' },
								{ text: 'YOUR PRINT', tone: 'yellow' },
							],
							title: `${print.title} + Cable clip ×2`,
							meta: `${print.printer} · ${print.material} ${print.color} · Shared build plate (2 students) · Est. ready ${print.estReady}`,
							yours: true,
						},
						{
							badges: [{ text: 'After plate clear', tone: 'gray' }],
							title: 'Drone arm ×3',
							meta: `${print.printer} · ${print.material} ${print.color} · Starts when the plate above is removed`,
						},
						{
							badges: [{ text: 'Overnight', tone: 'gray' }],
							title: 'Enclosure lid (est. 9 h 10 m)',
							meta: "Prusa Core ONE+ · PETG black · Too long for today’s shift",
						},
					],
				},
			];
	}
}

// ---------- renderers ----------

function renderJob(job: QueueJob): string {
	const badges = job.badges.map((b) => `<span class="badge badge-${b.tone}">${esc(b.text)}</span>`).join('');
	const classes = ['job-row'];
	if (job.yours) classes.push('yours');
	if (job.ready) classes.push('ready');
	const why = job.why ? `<div class="why-here"><p>${esc(job.why)}</p></div>` : '';
	const side = job.progress !== undefined
		? `<div class="job-side"><div class="job-progress"><div class="progress-track"><span style="width:${job.progress}%"></span></div><span class="job-pct">${job.progress}%</span></div></div>`
		: job.details
			? `<div class="job-side"><a class="details-link" href="#">Details ›</a></div>`
			: '';
	return `<div class="${classes.join(' ')}">
  <div class="job-badges">${badges}</div>
  <div class="job-info">
    <p class="job-title">${esc(job.title)}</p>
    <p class="job-meta${job.metaGreen ? ' green' : ''}">${esc(job.meta)}</p>
    ${why}
  </div>
  ${side}
</div>`;
}

function renderQueue(print: MyPrint): string {
	return sectionsFor(print)
		.map(
			(section) => `<section class="queue-section">
  <div class="section-head"><h2>${esc(section.name)}</h2><span class="count-chip">${section.jobs.length}</span></div>
  <div class="job-list">${section.jobs.map(renderJob).join('')}</div>
</section>`,
		)
		.join('') + `<p class="queue-note">Updates every 15 seconds.</p>`;
}

function renderBanner(print: MyPrint): string {
	switch (print.status) {
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

function renderSteps(print: MyPrint): string {
	// queued → current step index 2; printing → 3; ready → all done; canceled → step 2 canceled
	const current = print.status === 'printing' ? 3 : print.status === 'queued' ? 2 : -1;
	const items: string[] = [];
	STEP_LABELS.forEach((label, i) => {
		if (i > 0) items.push(`<li class="step-connector${i <= current || print.status === 'ready' ? ' done' : ''}" aria-hidden="true"></li>`);
		let cls = 'step';
		let circle = `${i + 1}`;
		if (print.status === 'ready' || i < current) {
			cls += ' done';
			circle = '✓';
		} else if (i === current) {
			cls += print.status === 'canceled' ? ' canceled' : ' current';
			if (print.status === 'canceled') circle = '✕';
		}
		items.push(`<li class="${cls}"><span class="step-circle">${circle}</span><span class="step-label">${label}</span></li>`);
	});
	return `<ol class="steps">${items.join('')}</ol>`;
}

function statusBadge(print: MyPrint): string {
	switch (print.status) {
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
	if (print.status === 'printing') {
		return `${renderSteps(print)}
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
		return `${renderSteps(print)}
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
		return `${renderSteps(print)}
<div class="slice-box">
  <p class="box-title">Print request canceled</p>
  <p>“${esc(print.title)}” ${esc(print.ref)} was removed from the queue. Nothing was printed and no charge applies.</p>
</div>
<div class="panel-actions">
  <a class="button primary" href="/submit">Submit another print</a>
  <a class="button secondary" href="/">Back to queue</a>
</div>`;
	}
	return `${renderSteps(print)}
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

function renderPanel(print: MyPrint): string {
	return `<p class="panel-label">MY PRINT</p>
<div class="panel-title-row">
  <h2 class="panel-title">${esc(print.title)} · ${esc(print.ref)}</h2>
  ${statusBadge(print)}
</div>
${renderPanelBody(print)}`;
}

// ---------- state transitions ----------

function advance(print: MyPrint, patch: Partial<MyPrint>): void {
	const next = { ...print, ...patch };
	saveMyPrint(next);
	render(next);
}

function render(print: MyPrint): void {
	$('queue-banner').innerHTML = renderBanner(print);
	$('queue-banner').hidden = false;
	$('queue-main').innerHTML = renderQueue(print);
	const panel = $('my-print');
	panel.innerHTML = renderPanel(print);
	panel.hidden = false;
	panel.querySelector('[data-action="demo-printing"]')?.addEventListener('click', () =>
		advance(print, { status: 'printing', progress: 45, startedAt: '2:31 PM', estReady: estReadyFromNow(print) }),
	);
	panel.querySelector('[data-action="demo-ready"]')?.addEventListener('click', () =>
		advance(print, { status: 'ready', progress: 100, finishedAt: '4:43 PM', cubby: 'Cubby B-04' }),
	);
	panel.querySelector('[data-action="cancel-print"]')?.addEventListener('click', () => advance(print, { status: 'canceled' }));
}

function estReadyFromNow(print: MyPrint): string {
	// ~est. print time from now, formatted like the queue ETAs (e.g. ~4:45 PM)
	const match = /(\d+)\s*h(?:\s*(\d+)\s*m)?/.exec(print.estTime);
	const hours = match ? Number(match[1]) : 2;
	const minutes = match ? Number(match[2] ?? 0) : 15;
	const ready = new Date(Date.now() + (hours * 60 + minutes) * 60_000);
	let h = ready.getHours() % 12;
	if (h === 0) h = 12;
	const ampm = ready.getHours() >= 12 ? 'PM' : 'AM';
	return `~${h}:${String(ready.getMinutes()).padStart(2, '0')} ${ampm}`;
}

function init(): void {
	if (typeof document === 'undefined' || !document.getElementById('queue-main')) return; // not the queue page (e.g. imported by /submit)
	const print = loadMyPrint();
	if (!print) return; // plain S0 queue home, server-rendered
	render(print);
}

init();
