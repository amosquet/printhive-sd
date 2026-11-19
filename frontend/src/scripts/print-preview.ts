/**
 * Interactive sliced print preview for the submission flow.
 *
 * Ported from the deployed PrintHive `Preview.tsx`: a three.js viewport renders
 * the selected model on the printer bed, while a background worker runs the
 * checksum-pinned Orca browser engine (`@time-estimator/browser-preview`) to
 * slice the model and generate support shapes. The Supports tab shows the
 * generated support overlay with a layer slider; print time comes from the same
 * slice. Orientation controls (auto / lay-on-face / reset) feed back into the
 * submission state.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  createPreviewClient,
  type PreviewClient,
  type FastSupportPreview,
} from '@time-estimator/browser-preview';
import { displayTransform } from '@time-estimator/browser-preview/geometry';
import {
  createSupportShapeOverlay,
  type SupportShapeOverlay,
} from '@time-estimator/browser-preview/three';
import {
  IDENTITY_ROTATION,
  poseMatrix,
  multiplyRotations,
  rotationForFace,
} from '@time-estimator/browser-preview/pose';
import { PreviewResultCache, previewCacheKey, runtimeCacheIdentity } from './preview-cache';
import {
  PREVIEW_PRINTERS,
  PREVIEW_PROFILE_FILES,
  parsePreviewProfile,
  selectPreviewPrinter,
  fitsPreviewPrinter,
  profileForPreviewBed,
  formatPrintTime,
  applyPrintTimeAllowance,
  type PrinterPreviewProfile,
} from './preview-profile';
import { previewColor, supportMode, type ModelUnits } from './print-settings';

export interface PreviewModel {
  file: File;
  rotation: number[];
  mirror: boolean;
  scale: number;
  positions: Float32Array;
  triangles: number;
  min: number[];
  max: number[];
  hullPositions?: Float32Array;
}

export interface PreviewInputs {
  file: File | null;
  rotation: number[];
  mirror: boolean;
  scale: number;
  color: string;
  colorName: string;
  copies: number;
  units: ModelUnits;
  infill: number;
  walls: number;
  layerHeight: number;
  supports: string;
  supportAngle?: number;
  settingsValid: boolean;
  disabled?: boolean;
  retainedFiles: File[];
}

export interface PreviewHooks {
  onRotationChange: (rotation: number[]) => void;
  onUseMeters: () => void;
}

const FACE_BUTTONS: Array<{ name: string; normal: number[] }> = [
  { name: 'Bottom', normal: [0, 0, -1] },
  { name: 'Top', normal: [0, 0, 1] },
  { name: 'Front', normal: [0, -1, 0] },
  { name: 'Back', normal: [0, 1, 0] },
  { name: 'Left', normal: [-1, 0, 0] },
  { name: 'Right', normal: [1, 0, 0] },
];

export class PrintPreview {
  private client: PreviewClient<File> | null = null;
  private orientationClient: PreviewClient<File> | null = null;
  private resultCache = new PreviewResultCache();
  private cacheRuntime: { key: string; wasmSha256: string } | null | undefined;
  private revision = 0;
  private estimateRevision = 0;
  private estimateDirty = true;
  private model: PreviewModel | null = null;
  private loadedProfile: {
    file: File;
    printerId: string;
    retry: number;
    profile?: PrinterPreviewProfile;
    error?: string;
  } | null = null;
  private preview: FastSupportPreview | null = null;

  /** Last sliced estimate in seconds (model + supports), when available. */
  get estimatedSeconds(): number | undefined {
    return this.preview?.estimatedSeconds;
  }
  private tab: 'model' | 'layers' = 'model';
  private reading = false;
  private orienting = false;
  private calculating = false;
  private calculationProgress: number | 'finishing' | null = null;
  private retry = 0;
  private message = '';
  private layerIndex = 0;
  private faceMode = false;
  private inputs: PreviewInputs | null = null;

  // scene refs
  private host: HTMLElement;
  private mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  private frame: THREE.Group | null = null;
  private overlay: SupportShapeOverlay | null = null;
  private requestDraw: () => void = () => {};
  private resetView: () => void = () => {};

  constructor(private root: HTMLElement, private hooks: PreviewHooks) {
    this.host = this.el('preview-viewport');
    this.bindStaticControls();
    void this.loadRuntimeIdentity();
  }

  dispose() {
    this.revision++;
    this.client?.dispose();
    this.orientationClient?.dispose();
    this.client = null;
    this.orientationClient = null;
    this.teardownScene();
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    const selector = id.startsWith('#') ? id : `#${id}`;
    const found = this.root.querySelector<T>(selector);
    if (!found) throw new Error(`Missing preview element ${selector}`);
    return found;
  }

  private async loadRuntimeIdentity() {
    try {
      const response = await fetch('/preview-engine/manifest.json');
      if (!response.ok) throw new Error('Missing engine identity');
      this.cacheRuntime = runtimeCacheIdentity(await response.json());
      this.sync();
      this.estimateMaybe();
    } catch {
      this.cacheRuntime = null;
      this.sync();
    }
  }

  private bindStaticControls() {
    this.el('tab-model').addEventListener('click', () => {
      this.tab = 'model';
      this.applyLayered();
      this.sync();
    });
    this.el('tab-layers').addEventListener('click', () => {
      this.faceMode = false;
      this.tab = 'layers';
      this.applyLayered();
      this.sync();
    });
    this.el('orient-auto').addEventListener('click', () => void this.autoOrient());
    this.el('orient-face').addEventListener('click', () => {
      this.faceMode = !this.faceMode;
      this.tab = 'model';
      this.reloadModel();
      this.sync();
    });
    this.el('orient-reset').addEventListener('click', () => {
      this.faceMode = false;
      this.hooks.onRotationChange([...IDENTITY_ROTATION]);
    });
    this.el('orient-cancel').addEventListener('click', () => this.orientationClient?.cancel());
    this.el('preview-reset-view').addEventListener('click', () => this.resetView());
    this.el('use-meters').addEventListener('click', () => this.hooks.onUseMeters());
    this.el('preview-retry').addEventListener('click', () => {
      this.message = '';
      this.retry++;
      this.loadProfile();
      this.sync();
    });
    const slider = this.el<HTMLInputElement>('layer-slider');
    slider.addEventListener('input', () => {
      this.layerIndex = Number(slider.value) - 1;
      this.applyLayered();
      this.sync();
    });

    const faceButtons = this.el('face-buttons');
    for (const face of FACE_BUTTONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = face.name;
      button.dataset.normal = JSON.stringify(face.normal);
      button.addEventListener('click', () => {
        const normal = new THREE.Vector3(...face.normal).applyMatrix3(
          new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().fromArray(poseMatrix(this.inputs?.rotation, this.inputs?.mirror))),
        );
        this.faceAction(normal.toArray());
      });
      faceButtons.appendChild(button);
    }
  }

  private makeClient() {
    return createPreviewClient<File>({
      manifestUrl: new URL('/preview-engine/manifest.json', window.location.origin).href,
      workerFactory: () => new Worker(new URL('../workers/support.worker.ts', import.meta.url), { type: 'module' }),
    });
  }

  private faceAction(normal: number[]) {
    if (!this.inputs) return;
    this.hooks.onRotationChange(multiplyRotations(rotationForFace(normal), this.inputs.rotation));
    this.faceMode = false;
    this.sync();
  }

  private async autoOrient() {
    const inputs = this.inputs;
    if (!inputs?.file || this.orienting || inputs.disabled) return;
    const currentRevision = ++this.revision;
    this.client?.cancel();
    this.orienting = true;
    this.tab = 'model';
    this.message = '';
    this.sync();
    try {
      this.orientationClient ??= this.makeClient();
      const result = await this.orientationClient.orient({
        input: inputs.file,
        rotation: inputs.rotation,
        mirrorX: inputs.mirror,
        scale: inputs.scale,
      });
      if (this.revision === currentRevision) {
        this.faceMode = false;
        this.hooks.onRotationChange(result.rotation);
      }
    } catch (error) {
      if (this.revision === currentRevision)
        this.message =
          (error as { code?: string }).code === 'canceled'
            ? 'Orientation canceled.'
            : error instanceof Error
              ? error.message.slice(0, 200)
              : "Couldn't find an orientation. Choose a face instead.";
    } finally {
      if (this.revision === currentRevision) {
        this.orienting = false;
        this.sync();
      }
    }
  }

  /** Called by the submission flow whenever any preview-relevant input changes. */
  update(inputs: PreviewInputs) {
    const prev = this.inputs;
    this.inputs = inputs;
    const poseChanged =
      prev?.file !== inputs.file ||
      prev?.rotation !== inputs.rotation ||
      prev?.mirror !== inputs.mirror ||
      prev?.scale !== inputs.scale;
    const estimateChanged =
      !prev ||
      prev.file !== inputs.file ||
      prev.rotation !== inputs.rotation ||
      prev.mirror !== inputs.mirror ||
      prev.scale !== inputs.scale ||
      prev.infill !== inputs.infill ||
      prev.walls !== inputs.walls ||
      prev.layerHeight !== inputs.layerHeight ||
      prev.supports !== inputs.supports ||
      prev.supportAngle !== inputs.supportAngle ||
      prev.settingsValid !== inputs.settingsValid ||
      Boolean(prev.disabled) !== Boolean(inputs.disabled);
    if (poseChanged) {
      this.revision++;
      this.client?.cancel();
      this.orientationClient?.cancel();
      this.overlay?.dispose();
      this.overlay = null;
      this.preview = null;
      this.orienting = false;
      this.message = '';
      this.tab = 'model';
      this.faceMode = false;
      this.resultCache.retain(inputs.retainedFiles);
      this.reloadModel();
    }
    if (estimateChanged) this.estimateDirty = true;
    if (prev?.supports !== inputs.supports && inputs.supports === 'none') {
      this.tab = 'model';
      this.applyLayered();
    }
    if (this.estimateDirty) {
      this.estimateDirty = false;
      this.estimateMaybe();
    }
    this.sync();
  }

  private reloadModel() {
    const inputs = this.inputs;
    if (!inputs?.file) {
      this.model = null;
      this.teardownScene();
      this.sync();
      return;
    }
    const file = inputs.file;
    this.reading = true;
    this.sync();
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/stl.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      this.reading = false;
      this.message = 'Preview unavailable.';
      this.sync();
      return;
    }
    const revision = this.revision;
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (revision !== this.revision) return;
      this.reading = false;
      if (data.error) {
        this.message = "Couldn't open this preview.";
        this.model = null;
      } else {
        this.model = {
          ...(data as Omit<PreviewModel, 'file' | 'rotation' | 'mirror' | 'scale'>),
          file,
          rotation: inputs.rotation,
          mirror: inputs.mirror,
          scale: inputs.scale,
        };
      }
      this.teardownScene();
      this.buildScene();
      this.loadProfile();
      this.estimateMaybe();
      this.sync();
    };
    worker.onerror = () => {
      worker.terminate();
      if (revision !== this.revision) return;
      this.reading = false;
      this.message = "Couldn't open this preview.";
      this.sync();
    };
    worker.postMessage({
      file,
      name: file.name,
      rotation: inputs.rotation,
      mirror: inputs.mirror,
      scale: inputs.scale,
      hull: this.faceMode,
    });
  }

  private loadProfile() {
    const inputs = this.inputs;
    const model = this.model;
    if (!inputs?.file || !model) return;
    const dimensions = model.min.map((value, i) => model.max[i] - value);
    const printer = selectPreviewPrinter(dimensions);
    const controller = new AbortController();
    const file = inputs.file;
    this.loadedProfile = null;
    fetch(PREVIEW_PROFILE_FILES[printer.id], { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Missing printer settings (${response.status})`);
        return parsePreviewProfile(await response.json(), printer.id);
      })
      .then((profile) => {
        if (controller.signal.aborted) return;
        this.loadedProfile = { file, printerId: printer.id, retry: this.retry, profile };
        this.estimateDirty = true;
        this.estimateMaybe();
        this.sync();
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        this.loadedProfile = {
          file,
          printerId: printer.id,
          retry: this.retry,
          error: `Couldn't load slicer settings for ${printer.name}. Reload to try again.`,
        };
        this.sync();
      });
  }

  private estimateMaybe() {
    const inputs = this.inputs;
    const model = this.model;
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (!inputs) return;
    const modelMatches =
      model &&
      model.file === inputs.file &&
      model.rotation === inputs.rotation &&
      model.mirror === inputs.mirror &&
      model.scale === inputs.scale;
    if (!modelMatches) {
      this.calculating = false;
      this.sync();
      return;
    }
    this.client?.cancel();
    const dimensions = model ? model.min.map((value, i) => model.max[i] - value) : [];
    const printer = model ? selectPreviewPrinter(dimensions) : PREVIEW_PRINTERS[0];
    const activeProfile =
      this.loadedProfile?.file === inputs.file && this.loadedProfile.printerId === printer.id && this.loadedProfile.retry === this.retry
        ? this.loadedProfile
        : null;
    const profile = activeProfile?.profile ?? null;
    const fits = model ? fitsPreviewPrinter(dimensions, printer) : true;
    const tooSmall =
      Boolean(model) &&
      inputs.units === 'mm' &&
      Math.max(...dimensions) < 1 &&
      dimensions[2] < inputs.layerHeight / 2;
    if (
      !inputs.file ||
      this.cacheRuntime === undefined ||
      !profile ||
      !model ||
      !fits ||
      tooSmall ||
      this.orienting ||
      inputs.disabled
    ) {
      this.calculating = false;
      this.sync();
      return;
    }
    const effectiveProfile = profileForPreviewBed(profile, printer, inputs.supportAngle, inputs.walls);
    const key = this.cacheRuntime
      ? previewCacheKey(this.cacheRuntime.key, effectiveProfile, {
          rotation: inputs.rotation,
          mirror: inputs.mirror,
          scale: inputs.scale,
          infill: inputs.infill,
          walls: inputs.walls,
          layerHeight: inputs.layerHeight,
          supports: inputs.supports,
        })
      : null;
    const cached = key ? this.resultCache.get(inputs.file, key) : undefined;
    if (cached) {
      this.preview = { ...cached };
      this.layerIndex = Math.max(0, cached.layers.length - 1);
      this.calculating = false;
      this.applyOverlay();
      this.applyLayered();
      this.sync();
      return;
    }
    const revision = ++this.estimateRevision;
    this.calculating = true;
    this.calculationProgress = null;
    this.sync();
    const timer = window.setTimeout(async () => {
      try {
        this.client ??= this.makeClient();
        const result = await this.client.estimate(
          {
            input: inputs.file!,
            profile: effectiveProfile,
            support: supportMode(inputs.supports),
            scope: 'model_and_supports',
            mirrorX: inputs.mirror,
            rotation: inputs.rotation,
            scale: inputs.scale,
            infill: inputs.infill,
            layerHeight: inputs.layerHeight,
          },
          {
            onProgress: (progress) => {
              if (revision !== this.estimateRevision) return;
              if (progress.stage === 'extracting') this.calculationProgress = 'finishing';
              else if (progress.stage === 'generating' && Number.isFinite(progress.percent))
                this.calculationProgress = Math.max(
                  typeof this.calculationProgress === 'number' ? this.calculationProgress : 0,
                  Math.min(99, Math.round(progress.percent)),
                );
              this.sync();
            },
          },
        );
        if (revision === this.estimateRevision) {
          if (key && result.provenance.runtimeSha256 === this.cacheRuntime?.wasmSha256)
            this.resultCache.set(inputs.file!, key, result);
          this.preview = result;
          this.layerIndex = Math.max(0, result.layers.length - 1);
          this.calculating = false;
          this.applyOverlay();
          this.applyLayered();
          this.sync();
        }
      } catch (error) {
        if (revision === this.estimateRevision && (error as { code?: string }).code !== 'canceled') {
          this.message = error instanceof Error ? error.message.slice(0, 200) : "Couldn't prepare this preview.";
          this.calculating = false;
          this.sync();
        }
      } finally {
        if (revision === this.estimateRevision) {
          this.calculating = false;
          this.sync();
        }
      }
    }, 150);
    this.pendingTimer = timer;
  }
  private pendingTimer: number | null = null;

  // --- three.js scene (ported from the deployed Preview component) ---

  private teardownScene() {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.overlay?.dispose();
    this.overlay = null;
    const host = this.host;
    const canvas = host.querySelector('canvas');
    if (this.sceneCleanup) {
      this.sceneCleanup();
      this.sceneCleanup = null;
    }
    canvas?.remove();
    this.mesh = null;
    this.frame = null;
    this.requestDraw = () => {};
    this.resetView = () => {};
  }
  private sceneCleanup: (() => void) | null = null;

  private buildScene() {
    const model = this.model;
    if (!model) return;
    const inputs = this.inputs;
    const printer = selectPreviewPrinter(model.min.map((value, i) => model.max[i] - value));
    const element = this.host;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      this.message = '3D preview unavailable.';
      this.sync();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 40);
    scene.background = new THREE.Color('#d2d7da');
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    root.matrix.fromArray(displayTransform({ min: model.min, max: model.max }));
    root.matrixWorldNeedsUpdate = true;
    const frame = new THREE.Group();
    this.frame = frame;
    root.add(frame);
    scene.add(root);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(model.positions, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.65,
      metalness: 0.05,
      side: THREE.DoubleSide,
      color: previewColor(inputs?.colorName ?? '', inputs?.color),
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldNeedsUpdate = true;
    this.mesh = mesh;
    root.add(mesh);
    scene.add(new THREE.HemisphereLight('#ffffff', '#626d78', 1.8));
    const light = new THREE.DirectionalLight('#ffffff', 2);
    light.position.set(4, 6, 4);
    scene.add(light);
    const { x: bedWidth, y: bedDepth } = printer.buildVolume;
    const grid = new THREE.GridHelper(bedWidth, Math.max(1, Math.round(bedWidth / 10)), '#a5afb6', '#6e7b84');
    grid.rotation.x = Math.PI / 2;
    grid.scale.z = bedDepth / bedWidth;
    grid.position.z = -0.02;
    root.add(grid);
    const bed = new THREE.Mesh(
      new THREE.PlaneGeometry(bedWidth, bedDepth),
      new THREE.MeshStandardMaterial({ color: '#48545c', roughness: 1 }),
    );
    bed.position.z = -0.05;
    root.add(bed);
    let hull: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;
    let highlight: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;
    if (model.hullPositions) {
      const hullGeometry = new THREE.BufferGeometry();
      hullGeometry.setAttribute('position', new THREE.BufferAttribute(model.hullPositions, 3));
      hullGeometry.computeVertexNormals();
      hull = new THREE.Mesh(
        hullGeometry,
        new THREE.MeshBasicMaterial({
          color: '#5ba161',
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      );
      hull.matrixAutoUpdate = false;
      hull.matrixWorldNeedsUpdate = true;
      hull.renderOrder = 2;
      root.add(hull);
      highlight = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({
          color: '#e8cb65',
          transparent: true,
          opacity: 0.65,
          depthWrite: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
        }),
      );
      highlight.matrixAutoUpdate = false;
      highlight.matrix.copy(hull.matrix);
      highlight.matrixWorldNeedsUpdate = true;
      highlight.visible = false;
      highlight.renderOrder = 3;
      root.add(highlight);
    }
    const raycaster = new THREE.Raycaster();
    let down = [0, 0];
    const extent = Math.max(...model.max.map((value, i) => value - model.min[i]), 0.000001);
    const pointerDown = (event: PointerEvent) => {
      down = [event.clientX, event.clientY];
    };
    const pickFace = (event: PointerEvent) => {
      if (!hull) return undefined;
      const rect = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          1 - ((event.clientY - rect.top) / rect.height) * 2,
        ),
        camera,
      );
      root.updateMatrixWorld(true);
      return raycaster.intersectObject(hull)[0];
    };
    let highlightedPlane = '';
    const pointerLeave = () => {
      if (highlight) highlight.visible = false;
      highlightedPlane = '';
      this.requestDraw();
    };
    const pointerMove = (event: PointerEvent) => {
      if (!this.faceMode || !hull || !highlight || !model.hullPositions) return;
      const hit = pickFace(event);
      renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
      if (!hit?.face) {
        pointerLeave();
        return;
      }
      const normal = hit.face.normal;
      const source = model.hullPositions;
      const point = new THREE.Vector3().fromArray(source, hit.face.a * 3);
      const distance = normal.dot(point);
      const key = normal.toArray().map((v) => v.toFixed(5)).join(',') + distance.toFixed(4);
      if (key === highlightedPlane) return;
      highlightedPlane = key;
      const normals = hull.geometry.getAttribute('normal');
      const selected: number[] = [];
      for (let i = 0; i < source.length; i += 9) {
        const faceNormal = new THREE.Vector3().fromBufferAttribute(normals, i / 3);
        const vertex = new THREE.Vector3().fromArray(source, i);
        if (faceNormal.dot(normal) > 1 - 1e-5 && Math.abs(normal.dot(vertex) - distance) < extent * 1e-5)
          selected.push(...source.subarray(i, i + 9));
      }
      highlight.geometry.dispose();
      highlight.geometry = new THREE.BufferGeometry();
      highlight.geometry.setAttribute('position', new THREE.Float32BufferAttribute(selected, 3));
      highlight.visible = true;
      this.requestDraw();
    };
    const pointerUp = (event: PointerEvent) => {
      if (!this.faceMode || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 5) return;
      const hit = pickFace(event);
      if (hit?.face) {
        const normal = hit.face.normal.clone().normalize();
        this.faceAction(normal.toArray());
      }
    };
    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    renderer.domElement.addEventListener('pointermove', pointerMove);
    renderer.domElement.addEventListener('pointerleave', pointerLeave);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.minDistance = 1;
    controls.maxDistance = 15;
    let animation = 0;
    let disposed = false;
    const requestDraw = () => {
      if (!animation && !disposed) animation = requestAnimationFrame(draw);
    };
    const draw = () => {
      animation = 0;
      controls.update();
      renderer.render(scene, camera);
    };
    this.requestDraw = requestDraw;
    controls.addEventListener('change', requestDraw);
    this.resetView = () => {
      camera.position.set(3.4, 2.5, 4.3);
      controls.target.set(0, 0, 0);
      controls.update();
    };
    this.resetView();
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth, height = element.clientHeight;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      requestDraw();
    });
    observer.observe(element);
    requestDraw();
    this.sceneCleanup = () => {
      disposed = true;
      cancelAnimationFrame(animation);
      this.requestDraw = () => {};
      observer.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('pointermove', pointerMove);
      renderer.domElement.removeEventListener('pointerleave', pointerLeave);
      hull?.geometry.dispose();
      hull?.material.dispose();
      highlight?.geometry.dispose();
      highlight?.material.dispose();
      bed.geometry.dispose();
      bed.material.dispose();
      this.overlay?.dispose();
      this.overlay = null;
      this.frame = null;
      this.mesh = null;
      geometry.dispose();
      material.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
    this.sync();
  }

  setColor(colorHex: string, colorName: string) {
    if (this.mesh && this.inputs) {
      this.inputs.color = colorHex;
      this.inputs.colorName = colorName;
      this.mesh.material.color.set(previewColor(colorName, colorHex));
      this.requestDraw();
    }
  }

  private applyOverlay() {
    this.overlay?.dispose();
    this.overlay = null;
    const model = this.model;
    const preview = this.preview;
    if (!preview || !this.frame || !model) return;
    const center = model.min.map((value, i) => (value + model.max[i]) / 2);
    this.frame.position.set(
      center[0] - (preview.bounds.min[0] + preview.bounds.max[0]) / 2,
      center[1] - (preview.bounds.min[1] + preview.bounds.max[1]) / 2,
      model.min[2],
    );
    try {
      this.overlay = createSupportShapeOverlay(preview);
    } catch (error) {
      this.message = error instanceof Error ? error.message : "Couldn't display supports.";
      this.requestDraw();
      return;
    }
    this.frame.add(this.overlay.group);
  }

  private applyLayered() {
    const layered = this.tab === 'layers' && Boolean(this.preview?.shapes.length && this.preview?.layers.length);
    if (this.mesh) {
      this.mesh.visible = true;
      const material = this.mesh.material;
      const showSupports = layered && Boolean(this.preview?.shapes.length);
      if (material.transparent !== showSupports) {
        material.transparent = showSupports;
        material.depthWrite = !showSupports;
        material.needsUpdate = true;
      }
      material.opacity = showSupports ? 0.3 : 1;
    }
    if (this.overlay) {
      this.overlay.setVisible(layered);
      const layer = this.preview?.layers[this.layerIndex];
      if (layer) this.overlay.setLayerRange(-Infinity, layer.printZ + 0.000001);
    }
    this.requestDraw();
  }

  // --- DOM sync ---

  private sync() {
    const inputs = this.inputs;
    if (!inputs) {
      this.el('preview-placeholder').hidden = false;
      this.el('preview-placeholder-text').textContent = 'Choose a file to preview.';
      return;
    }
    const model = this.model;
    const file = inputs.file ?? null;
    const dimensions = model ? model.min.map((value, i) => model.max[i] - value) : [];
    const printer = model ? selectPreviewPrinter(dimensions) : PREVIEW_PRINTERS[0];
    const activeProfile =
      this.loadedProfile?.file === file && this.loadedProfile.printerId === printer.id && this.loadedProfile.retry === this.retry
        ? this.loadedProfile
        : null;
    const profile = activeProfile?.profile ?? null;
    const profileError = activeProfile?.error;
    const fits = model ? fitsPreviewPrinter(dimensions, printer) : true;
    const tooSmall =
      Boolean(model) && inputs!.units === 'mm' && Math.max(...dimensions) < 1 && dimensions[2] < inputs!.layerHeight / 2;
    const layered = this.tab === 'layers' && Boolean(this.preview?.shapes.length && this.preview?.layers.length);
    const noSupportsNeeded =
      Boolean(model) && this.preview && inputs!.supports !== 'none' && this.preview.shapes.length === 0 && !this.calculating && inputs!.settingsValid;

    this.el('tab-model').setAttribute('aria-selected', String(this.tab === 'model'));
    const tabLayers = this.el<HTMLButtonElement>('tab-layers');
    tabLayers.setAttribute('aria-selected', String(this.tab === 'layers'));
    tabLayers.disabled = inputs!.supports === 'none' || !model || !profile || Boolean(inputs!.disabled) || tooSmall;

    this.el('preview-file').hidden = !file;
    if (file) this.el('preview-file-name').textContent = file.name;

    this.el('print-time').hidden = !file;
    const timeAllowancePercent = profile?.timeAllowancePercent ?? 30;
    const seconds = this.preview?.estimatedSeconds;
    let time: string;
    if (file) {
      time =
        seconds !== undefined
          ? formatPrintTime(applyPrintTimeAllowance(seconds, timeAllowancePercent), true)
          : this.orienting
            ? 'Waiting for orientation…'
            : !fits || tooSmall || !inputs!.settingsValid || profileError
              ? 'Unavailable'
              : this.calculating || this.reading || (!profile && !profileError) || (!this.message && !profileError && !inputs!.disabled && !tooSmall)
                ? this.calculationProgress === 'finishing'
                  ? 'Finishing…'
                  : this.calculationProgress === null
                    ? 'Calculating…'
                    : `Calculating… ${this.calculationProgress}%`
                : 'Unavailable';
    } else time = '';
    this.el('print-time-value').textContent = time;
    this.el('print-time-printer').textContent = model ? `For ${printer.name}` : '';
    this.el('print-time-printer').hidden = !model;
    this.el('print-time-note').textContent = this.preview ? 'Quick estimate' : '';
    this.el('print-time-note').hidden = !this.preview;
    const copiesEl = this.el('print-time-copies');
    copiesEl.textContent = inputs!.copies > 1 ? `per copy · ${inputs!.copies} copies` : '';
    copiesEl.hidden = inputs!.copies <= 1;

    this.el('support-result').hidden = !noSupportsNeeded;

    const toolbar = this.el('orientation-toolbar');
    toolbar.hidden = !file;
    this.el<HTMLButtonElement>('orient-auto').disabled = this.orienting || Boolean(inputs!.disabled) || !model;
    const faceBtn = this.el<HTMLButtonElement>('orient-face');
    faceBtn.disabled = this.orienting || Boolean(inputs!.disabled) || this.reading;
    faceBtn.setAttribute('aria-pressed', String(this.faceMode));
    this.el<HTMLButtonElement>('orient-reset').disabled = this.orienting || Boolean(inputs!.disabled);
    this.el('face-picker').hidden = !this.faceMode;
    for (const button of Array.from(this.el('face-buttons').querySelectorAll('button')))
      (button as HTMLButtonElement).disabled = Boolean(inputs!.disabled) || this.reading;

    this.el('preview-canvas-frame').classList.toggle('has-layers', layered);
    this.el('preview-viewport').setAttribute('aria-label', layered ? 'Generated support shapes' : 'Interactive model preview');
    this.el('preview-placeholder').hidden = Boolean(model);
    this.el('preview-placeholder-text').textContent = this.reading ? 'Opening model…' : 'Choose a file to preview.';
    this.el('preview-loading').hidden = !this.orienting;

    this.el('layer-rail').hidden = !layered;
    if (this.preview) {
      const slider = this.el<HTMLInputElement>('layer-slider');
      slider.max = String(this.preview.layers.length);
      slider.value = String(this.layerIndex + 1);
      this.el('layer-count-max').textContent = String(this.preview.layers.length);
    }
    this.el('layer-controls').hidden = !layered;
    if (layered && this.preview) this.el('layer-heading-text').textContent = `Layer ${this.layerIndex + 1} / ${this.preview.layers.length}`;
    this.el<HTMLButtonElement>('preview-reset-view').disabled = !model;

    const fit = this.el('printer-fit');
    fit.hidden = !model;
    if (model) {
      const badges = this.el('fit-badges');
      badges.innerHTML = '';
      for (const p of PREVIEW_PRINTERS) {
        const ok = fitsPreviewPrinter(dimensions, p);
        const span = document.createElement('span');
        span.className = `fit-badge ${ok ? 'fits' : 'exceeds'}`;
        span.textContent = `${p.name}: ${ok ? 'Fits' : 'Exceeds'}`;
        badges.appendChild(span);
      }
    }
    const bedEl = this.el('preview-bed');
    bedEl.hidden = !model;
    if (model) {
      this.el('preview-bed-name').textContent = printer.name;
      this.el('preview-bed-size').textContent = `${printer.buildVolume.x} × ${printer.buildVolume.y} mm`;
      this.el('preview-bed-warning').textContent = !fits ? ' Too large for this bed. Rotate the part or choose a smaller model.' : '';
      this.el('preview-bed-warning').style.display = !fits ? 'block' : 'none';
    }

    const calc = this.el('preview-calculating');
    calc.hidden = !this.calculating;
    if (this.calculating)
      calc.textContent =
        this.calculationProgress === 'finishing'
          ? 'Finishing supports…'
          : typeof this.calculationProgress === 'number'
            ? `Preparing supports… ${this.calculationProgress}%`
            : 'Preparing supports…';

    this.el('unit-warning').hidden = !tooSmall;
    this.el<HTMLButtonElement>('use-meters').disabled = Boolean(inputs!.disabled);

    const msg = this.el('preview-message');
    msg.hidden = !(this.message || profileError);
    if (this.message || profileError) {
      this.el('preview-message-text').textContent = `${this.message || profileError} `;
      this.el('preview-retry').hidden = !(profile && !this.calculating && !this.orienting && fits);
    }
    this.el('preview-dimensions').textContent = model ? `${dimensions.map((v) => Number(v.toFixed(1))).join(' × ')} mm` : '';
  }
}
