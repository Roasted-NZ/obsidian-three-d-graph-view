import {
  App,
  getAllTags,
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf
} from "obsidian";

import {
  AmbientLight,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation
} from "d3-force-3d";

const VIEW_TYPE_3D_GRAPH = "3d-graph-view";

interface Graph3DSettings {
  showLabels: boolean;
  linkDistance: number;
  nodeSize: number;
  includeUnresolvedLinks: boolean;
  componentSpread: number;
  showBacklinks: boolean;
  includeTags: boolean;
  enabledTags: Record<string, boolean>;
  tagColors: Record<string, string>;
  constrainToSphere: boolean;
  sphereStrength: number;
}

const DEFAULT_SETTINGS: Graph3DSettings = {
  showLabels: true,
  linkDistance: 70,
  nodeSize: 5,
  includeUnresolvedLinks: true,
  componentSpread: 0.33,
  showBacklinks: true,
  includeTags: true,
  enabledTags: {},
  tagColors: {},
  constrainToSphere: true,
  sphereStrength: 0.08
};

const DEFAULT_TAG_COLORS = [
  "#37a169",
  "#3182ce",
  "#d69e2e",
  "#805ad5",
  "#dd6b20",
  "#319795",
  "#d53f8c",
  "#718096"
];

interface GraphNode {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  kind: "note" | "tag";
  createdTime: number;
  val: number;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  componentIndex?: number;
}

interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  value: number;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  components: GraphComponent[];
}

interface GraphComponent {
  index: number;
  nodeIds: string[];
  anchor: Vector3;
}

export default class Graph3DPlugin extends Plugin {
  settings: Graph3DSettings;

  async onload(): Promise<void> {
    const savedSettings = await this.loadData();
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...savedSettings,
      enabledTags: {
        ...DEFAULT_SETTINGS.enabledTags,
        ...savedSettings?.enabledTags
      },
      tagColors: {
        ...DEFAULT_SETTINGS.tagColors,
        ...savedSettings?.tagColors
      }
    };
    this.syncTagSettings();

    this.registerView(
      VIEW_TYPE_3D_GRAPH,
      (leaf) => new Graph3DView(leaf, this)
    );

    this.addRibbonIcon("orbit", "Open 3D graph view", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-3d-graph-view",
      name: "Open 3D graph view",
      callback: () => this.activateView()
    });

    this.addCommand({
      id: "refresh-3d-graph-view",
      name: "Refresh 3D graph view",
      callback: () => this.refreshOpenViews()
    });

    this.addSettingTab(new Graph3DSettingTab(this.app, this));

    this.registerEvent(
      this.app.metadataCache.on("resolved", () => this.refreshOpenViews())
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", () => {
        this.syncTagSettings();
        this.refreshOpenViews();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", () => this.refreshOpenViews())
    );
    this.registerEvent(
      this.app.vault.on("delete", () => this.refreshOpenViews())
    );
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_3D_GRAPH);
  }

  async activateView(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_3D_GRAPH)[0];

    if (existingLeaf) {
      this.app.workspace.revealLeaf(existingLeaf);
      return;
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_3D_GRAPH,
      active: true
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refreshOpenViews();
  }

  syncTagSettings(): string[] {
    const tags = getVaultTags(this.app);
    let changed = false;

    if (!this.settings.enabledTags) {
      this.settings.enabledTags = {};
      changed = true;
    }

    for (const tag of tags) {
      if (this.settings.enabledTags[tag] === undefined) {
        this.settings.enabledTags[tag] = true;
        changed = true;
      }
    }

    if (changed) {
      this.saveData(this.settings);
    }

    return tags;
  }

  refreshOpenViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_3D_GRAPH)) {
      const view = leaf.view;
      if (view instanceof Graph3DView) {
        view.refresh();
      }
    }
  }

  openSettings(): void {
    const setting = (this.app as App & {
      setting?: {
        open(): void;
        openTabById(id: string): void;
      };
    }).setting;

    if (!setting) {
      new Notice("Open Settings > Community plugins > 3D Graph View");
      return;
    }

    setting.open();
    setting.openTabById(this.manifest.id);
  }
}

class Graph3DView extends ItemView {
  private graphContainer?: HTMLDivElement;
  private resizeObserver?: ResizeObserver;
  private renderer?: WebGLRenderer;
  private scene?: Scene;
  private camera?: PerspectiveCamera;
  private controls?: OrbitControls;
  private animationFrame?: number;
  private simulation?: ReturnType<typeof forceSimulation>;
  private nodeMeshes: Mesh[] = [];
  private nodeByMesh = new Map<Mesh, GraphNode>();
  private linkLines?: LineSegments;
  private labels: Sprite[] = [];
  private labelTextures: Texture[] = [];
  private nodeTextures: Texture[] = [];
  private raycaster = new Raycaster();
  private pointer = new Vector2();
  private hoveredNodeId?: string;
  private hoverNeighbors = new Set<string>();
  private graphData?: GraphData;
  private timelapseButton?: HTMLButtonElement;
  private timelapseTimer?: number;
  private isTimelapseRunning = false;
  private timelapseNodeIds: string[] = [];
  private revealedNodeIds = new Set<string>();

  constructor(leaf: WorkspaceLeaf, private plugin: Graph3DPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_3D_GRAPH;
  }

  getDisplayText(): string {
    return "3D Graph";
  }

  getIcon(): string {
    return "orbit";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("graph-3d-view");

    const toolbar = this.contentEl.createDiv("graph-3d-toolbar");
    const refreshButton = toolbar.createEl("button", {
      attr: {
        "aria-label": "Refresh graph"
      },
      text: "Refresh"
    });
    refreshButton.addEventListener("click", () => this.refresh());

    const fitButton = toolbar.createEl("button", {
      attr: {
        "aria-label": "Fit graph to view"
      },
      text: "Fit"
    });
    fitButton.addEventListener("click", () => this.zoomToFit());

    const settingsButton = toolbar.createEl("button", {
      attr: {
        "aria-label": "Open 3D graph settings"
      },
      text: "Settings"
    });
    settingsButton.addEventListener("click", () => this.plugin.openSettings());

    this.timelapseButton = toolbar.createEl("button", {
      attr: {
        "aria-label": "Play graph timelapse"
      },
      text: "Timelapse"
    });
    this.timelapseButton.addEventListener("click", () => this.toggleTimelapse());

    this.graphContainer = this.contentEl.createDiv("graph-3d-canvas");

    this.resizeObserver = new ResizeObserver(() => this.resizeGraph());
    this.resizeObserver.observe(this.contentEl);

    this.renderGraph();
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;

    this.disposeGraph();
  }

  refresh(): void {
    if (!this.graphContainer) {
      return;
    }

    this.renderGraph();
  }

  private renderGraph(): void {
    if (!this.graphContainer) {
      return;
    }

    const graphData = buildGraphData(this.app, this.plugin.settings);

    this.disposeGraph();

    if (graphData.nodes.length === 0) {
      this.graphContainer.empty();
      this.graphContainer.createDiv({
        cls: "graph-3d-empty",
        text: "No notes with links found."
      });
      return;
    }

    this.graphContainer.empty();

    this.createScene(graphData);
    this.resizeGraph();
    window.setTimeout(() => this.zoomToFit(), 400);
  }

  private disposeGraph(): void {
    this.stopTimelapse(false);

    if (this.animationFrame !== undefined) {
      window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = undefined;
    }

    this.simulation?.stop();
    this.simulation = undefined;

    this.controls?.dispose();
    this.controls = undefined;

    for (const mesh of this.nodeMeshes) {
      mesh.geometry.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) {
        material.forEach((item) => item.dispose());
      } else {
        material.dispose();
      }
    }
    this.nodeMeshes = [];
    this.nodeByMesh.clear();
    this.hoveredNodeId = undefined;
    this.hoverNeighbors.clear();
    this.graphData = undefined;
    this.timelapseNodeIds = [];
    this.revealedNodeIds.clear();

    if (this.linkLines) {
      this.linkLines.geometry.dispose();
      const material = this.linkLines.material;
      if (Array.isArray(material)) {
        material.forEach((item) => item.dispose());
      } else {
        material.dispose();
      }
      this.linkLines = undefined;
    }

    for (const label of this.labels) {
      const material = label.material;
      if (Array.isArray(material)) {
        material.forEach((item) => item.dispose());
      } else {
        material.dispose();
      }
    }
    this.labels = [];

    for (const texture of this.labelTextures) {
      texture.dispose();
    }
    this.labelTextures = [];

    for (const texture of this.nodeTextures) {
      texture.dispose();
    }
    this.nodeTextures = [];

    if (this.renderer) {
      this.renderer.domElement.removeEventListener("click", this.handleCanvasClick);
      this.renderer.domElement.removeEventListener("mousemove", this.handleCanvasMove);
      this.renderer.domElement.removeEventListener("mouseleave", this.handleCanvasLeave);
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
    this.renderer = undefined;
    this.scene = undefined;
    this.camera = undefined;
  }

  private createScene(graphData: GraphData): void {
    if (!this.graphContainer) {
      return;
    }

    this.graphData = graphData;

    const styles = getComputedStyle(document.body);
    const backgroundColor = styles.getPropertyValue("--background-primary").trim() || "#000000";
    const nodeColor = resolveThemeColor(styles.getPropertyValue("--interactive-accent"), "#7c6df2");
    const unresolvedNodeColor = resolveThemeColor(styles.getPropertyValue("--text-faint"), "#8a8a8a");
    const labelColor = resolveThemeColor(styles.getPropertyValue("--text-normal"), "#ffffff");

    seedNodePositions(graphData.nodes, graphData.components, this.plugin.settings.componentSpread);

    this.scene = new Scene();
    this.scene.background = new Color(backgroundColor);

    this.camera = new PerspectiveCamera(55, 1, 0.1, 10000);
    this.camera.position.set(0, 0, 420);

    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.graphContainer.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.6;

    this.scene.add(new AmbientLight(0xffffff, 1));

    const nodeGeometry = new SphereGeometry(1, 24, 24);
    const existingMaterial = this.createNodeMaterial(nodeColor);
    const unresolvedMaterial = this.createNodeMaterial(unresolvedNodeColor, {
      transparent: true,
      opacity: 0.78
    });

    for (const node of graphData.nodes) {
      const material = node.kind === "tag"
        ? this.createNodeMaterial(getTagColor(node.name, this.plugin.settings))
        : node.exists
          ? existingMaterial.clone()
          : unresolvedMaterial.clone();
      const mesh = new Mesh(nodeGeometry, material);
      const radius = Math.max(3, Math.sqrt(node.val) * this.plugin.settings.nodeSize);
      mesh.scale.setScalar(radius);
      mesh.userData.baseRadius = radius;
      mesh.userData.nodeId = node.id;
      this.scene.add(mesh);
      this.nodeMeshes.push(mesh);
      this.nodeByMesh.set(mesh, node);

      if (this.plugin.settings.showLabels) {
        const label = this.createLabel(node.name, labelColor);
        label.userData.nodeId = node.id;
        label.userData.baseScaleX = label.scale.x;
        label.userData.baseScaleY = label.scale.y;
        this.scene.add(label);
        this.labels.push(label);
      }
    }

    const linkGeometry = new BufferGeometry();
    updateLinkGeometry(linkGeometry, graphData.links, this.hoveredNodeId, this.hoverNeighbors, this.getVisibleNodeIds());
    this.linkLines = new LineSegments(
      linkGeometry,
      new LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.48
      })
    );
    this.scene.add(this.linkLines);

    this.renderer.domElement.addEventListener("click", this.handleCanvasClick);
    this.renderer.domElement.addEventListener("mousemove", this.handleCanvasMove);
    this.renderer.domElement.addEventListener("mouseleave", this.handleCanvasLeave);

    this.syncGraphObjects(graphData);
    this.applyVisibilityStyles();

    this.simulation = forceSimulation([], 3)
      .nodes(graphData.nodes as never[])
      .force("link", forceLink(graphData.links as never[]).id((node: GraphNode) => node.id).distance(this.plugin.settings.linkDistance).strength(0.6))
      .force("charge", forceManyBody().strength(-180))
      .force("collide", forceCollide().radius((node: GraphNode) => Math.max(12, Math.sqrt(node.val) * this.plugin.settings.nodeSize * 2)))
      .force("componentSpread", createComponentSpreadForce(graphData.components))
      .force("sphere", this.plugin.settings.constrainToSphere
        ? createSphericalVolumeForce(graphData.nodes, getGraphSphereRadius(graphData.nodes), this.plugin.settings.sphereStrength)
        : null)
      .force("center", forceCenter(0, 0, 0))
      .on("tick", () => this.syncGraphObjects(graphData));

    this.animate();
  }

  private createNodeMaterial(
    color: string,
    options: { transparent?: boolean; opacity?: number } = {}
  ): MeshBasicMaterial {
    const texture = createShadedNodeTexture(color);
    this.nodeTextures.push(texture);

    return new MeshBasicMaterial({
      map: texture,
      transparent: options.transparent,
      opacity: options.opacity ?? 1
    });
  }

  private createLabel(text: string, color: string): Sprite {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = 512;
    canvas.height = 128;

    if (context) {
      drawSmallCapsLabel(context, text, color, canvas.width, canvas.height);
    }

    const texture = new Texture(canvas);
    texture.needsUpdate = true;
    this.labelTextures.push(texture);

    const sprite = new Sprite(new SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false
    }));
    sprite.renderOrder = 10;
    sprite.scale.set(96, 24, 1);
    return sprite;
  }

  private syncGraphObjects(graphData: GraphData): void {
    const nodesById = new Map(graphData.nodes.map((node) => [node.id, node]));

    for (const mesh of this.nodeMeshes) {
      const node = this.nodeByMesh.get(mesh);
      if (!node) {
        continue;
      }
      mesh.position.set(node.x ?? 0, node.y ?? 0, node.z ?? 0);
    }

    for (const label of this.labels) {
      const node = nodesById.get(label.userData.nodeId);
      if (!node) {
        continue;
      }
      label.position.set(node.x ?? 0, (node.y ?? 0) + 14, node.z ?? 0);
    }

    if (this.linkLines) {
      updateLinkGeometry(this.linkLines.geometry, graphData.links, this.hoveredNodeId, this.hoverNeighbors, this.getVisibleNodeIds());
    }
  }

  private animate = (): void => {
    if (!this.renderer || !this.scene || !this.camera) {
      return;
    }

    this.controls?.update();
    this.updateHoverPulse();
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = window.requestAnimationFrame(this.animate);
  };

  private updateHoverPulse(): void {
    const time = performance.now() / 1000;

    for (const mesh of this.nodeMeshes) {
      const baseRadius = mesh.userData.baseRadius ?? 1;
      if (mesh.userData.nodeId === this.hoveredNodeId) {
        const pulse = 1.14 + Math.sin(time * 6.5) * 0.055;
        mesh.scale.setScalar(baseRadius * pulse);
      } else {
        mesh.scale.setScalar(baseRadius);
      }
    }

    for (const label of this.labels) {
      const baseScaleX = label.userData.baseScaleX ?? 96;
      const baseScaleY = label.userData.baseScaleY ?? 24;
      if (label.userData.nodeId === this.hoveredNodeId) {
        const pulse = 1.1 + Math.sin(time * 6.5) * 0.045;
        label.scale.set(baseScaleX * pulse, baseScaleY * pulse, 1);
      } else {
        label.scale.set(baseScaleX, baseScaleY, 1);
      }
    }
  }

  private handleCanvasClick = (event: MouseEvent): void => {
    const node = this.pickNode(event);
    if (node) {
      this.openNode(node);
    }
  };

  private handleCanvasMove = (event: MouseEvent): void => {
    const node = this.pickNode(event);
    const nextHoveredNodeId = node?.id;

    if (nextHoveredNodeId === this.hoveredNodeId) {
      return;
    }

    this.hoveredNodeId = nextHoveredNodeId;
    this.hoverNeighbors = nextHoveredNodeId && this.graphData
      ? getDirectConnectionIds(this.graphData.links, nextHoveredNodeId)
      : new Set<string>();
    this.applyVisibilityStyles();
  };

  private handleCanvasLeave = (): void => {
    if (!this.hoveredNodeId) {
      return;
    }

    this.hoveredNodeId = undefined;
    this.hoverNeighbors.clear();
    this.applyVisibilityStyles();
  };

  private pickNode(event: MouseEvent): GraphNode | null {
    if (!this.renderer || !this.camera) {
      return null;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const [hit] = this.raycaster.intersectObjects(this.nodeMeshes);
    if (!hit || !(hit.object instanceof Mesh)) {
      return null;
    }

    const node = this.nodeByMesh.get(hit.object) ?? null;
    if (node && this.isTimelapseRunning && !this.revealedNodeIds.has(node.id)) {
      return null;
    }

    return node;
  }

  private applyVisibilityStyles(): void {
    const hasHover = this.hoveredNodeId !== undefined;
    const visibleNodeIds = this.getVisibleNodeIds();

    for (const mesh of this.nodeMeshes) {
      const material = mesh.material;
      if (Array.isArray(material)) {
        continue;
      }

      const nodeId = String(mesh.userData.nodeId);
      const isVisible = !visibleNodeIds || visibleNodeIds.has(nodeId);
      const isDirect = !hasHover || nodeId === this.hoveredNodeId || this.hoverNeighbors.has(nodeId);
      material.transparent = true;
      material.opacity = isVisible ? isDirect ? 1 : 0.18 : 0;
      if ("color" in material && material.color instanceof Color) {
        material.color.set(isDirect ? "#ffffff" : "#8a8a8a");
      }
      material.needsUpdate = true;
    }

    for (const label of this.labels) {
      const material = label.material;
      if (Array.isArray(material)) {
        continue;
      }

      const nodeId = String(label.userData.nodeId);
      const isVisible = !visibleNodeIds || visibleNodeIds.has(nodeId);
      const isDirect = !hasHover || nodeId === this.hoveredNodeId;
      material.opacity = isVisible ? isDirect ? 1 : 0.16 : 0;
      material.needsUpdate = true;
    }

    if (this.linkLines && this.graphData) {
      updateLinkGeometry(this.linkLines.geometry, this.graphData.links, this.hoveredNodeId, this.hoverNeighbors, visibleNodeIds);
    }
  }

  private toggleTimelapse(): void {
    if (this.isTimelapseRunning) {
      this.stopTimelapse(true);
      return;
    }

    this.startTimelapse();
  }

  private startTimelapse(): void {
    if (!this.graphData || this.graphData.nodes.length === 0) {
      return;
    }

    this.stopTimelapse(false);
    this.hoveredNodeId = undefined;
    this.hoverNeighbors.clear();
    this.isTimelapseRunning = true;
    this.revealedNodeIds.clear();
    this.timelapseNodeIds = [...this.graphData.nodes]
      .sort((a, b) => a.createdTime - b.createdTime || a.name.localeCompare(b.name))
      .map((node) => node.id);
    if (this.timelapseButton) {
      this.timelapseButton.textContent = "Stop";
    }
    this.applyVisibilityStyles();

    const delay = Math.max(35, Math.min(220, Math.round(9000 / Math.max(1, this.timelapseNodeIds.length))));
    this.timelapseTimer = window.setInterval(() => this.advanceTimelapse(), delay);
  }

  private advanceTimelapse(): void {
    const nextNodeId = this.timelapseNodeIds.shift();
    if (!nextNodeId) {
      this.stopTimelapse(false);
      return;
    }

    this.revealedNodeIds.add(nextNodeId);
    this.applyVisibilityStyles();
  }

  private stopTimelapse(showFullGraph: boolean): void {
    if (this.timelapseTimer !== undefined) {
      window.clearInterval(this.timelapseTimer);
      this.timelapseTimer = undefined;
    }

    if (!this.isTimelapseRunning && !showFullGraph) {
      return;
    }

    this.isTimelapseRunning = false;
    this.timelapseNodeIds = [];
    this.revealedNodeIds.clear();
    if (this.timelapseButton) {
      this.timelapseButton.textContent = "Timelapse";
    }

    if (showFullGraph) {
      this.applyVisibilityStyles();
    }
  }

  private getVisibleNodeIds(): Set<string> | undefined {
    return this.isTimelapseRunning ? this.revealedNodeIds : undefined;
  }

  private resizeGraph(): void {
    if (!this.renderer || !this.camera || !this.graphContainer) {
      return;
    }

    const rect = this.graphContainer.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private zoomToFit(): void {
    if (!this.camera || !this.controls) {
      return;
    }

    const radius = Math.max(160, Math.sqrt(this.nodeMeshes.length) * 42);
    this.camera.position.set(0, 0, radius * 2.2);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  private async openNode(node: GraphNode): Promise<void> {
    if (!node.exists) {
      new Notice(`No file exists for ${node.name}`);
      return;
    }

    if (node.kind === "tag") {
      new Notice(`Tag node: ${node.name}`);
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(node.path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf("tab").openFile(file);
    }
  }
}

function buildGraphData(app: App, settings: Graph3DSettings): GraphData {
  const nodes = new Map<string, GraphNode>();
  const links = new Map<string, GraphLink>();
  const outgoingLinks = app.metadataCache.resolvedLinks;
  const markdownFiles = app.vault.getMarkdownFiles();
  const fileTimes = new Map(markdownFiles.map((file) => [file.path, file.stat.ctime || file.stat.mtime || Date.now()]));

  const ensureNode = (
    path: string,
    exists: boolean,
    kind: "note" | "tag" = "note",
    createdTime = fileTimes.get(path) ?? Date.now()
  ): GraphNode => {
    const existing = nodes.get(path);
    if (existing) {
      existing.exists = existing.exists || exists;
      existing.createdTime = Math.min(existing.createdTime, createdTime);
      return existing;
    }

    const name = kind === "tag" ? path.replace(/^tag:/, "") : path.split("/").pop()?.replace(/\.md$/, "") ?? path;
    const node: GraphNode = {
      id: path,
      name,
      path,
      exists,
      kind,
      createdTime,
      val: 1
    };
    nodes.set(path, node);
    return node;
  };

  for (const file of markdownFiles) {
    ensureNode(file.path, true, "note", fileTimes.get(file.path));
  }

  for (const [sourcePath, targets] of Object.entries(outgoingLinks)) {
    ensureNode(sourcePath, true, "note", fileTimes.get(sourcePath));

    for (const [targetPath, count] of Object.entries(targets)) {
      if (!settings.showBacklinks && !hasReciprocalLink(outgoingLinks, sourcePath, targetPath)) {
        continue;
      }
      ensureNode(targetPath, true, "note", fileTimes.get(targetPath));
      addLink(links, nodes, sourcePath, targetPath, count);
    }
  }

  if (settings.includeUnresolvedLinks) {
    for (const [sourcePath, targets] of Object.entries(app.metadataCache.unresolvedLinks)) {
      const sourceTime = fileTimes.get(sourcePath) ?? Date.now();
      ensureNode(sourcePath, true, "note", sourceTime);

      for (const [linktext, count] of Object.entries(targets)) {
        const resolvedPath = resolveUnresolvedLinkPath(app, linktext, sourcePath);
        if (!settings.showBacklinks && !hasReciprocalLink(outgoingLinks, sourcePath, resolvedPath)) {
          continue;
        }
        ensureNode(resolvedPath, false, "note", fileTimes.get(resolvedPath) ?? sourceTime);
        addLink(links, nodes, sourcePath, resolvedPath, count);
      }
    }
  }

  if (settings.includeTags) {
    for (const file of markdownFiles) {
      const cache = app.metadataCache.getFileCache(file);
      const tags = cache ? getAllTags(cache) : null;
      const fileTime = fileTimes.get(file.path) ?? Date.now();

      for (const tag of tags ?? []) {
        if (settings.enabledTags?.[tag] === false) {
          continue;
        }

        const tagNodeId = `tag:${tag}`;
        ensureNode(file.path, true, "note", fileTime);
        ensureNode(tagNodeId, true, "tag", fileTime);
        addLink(links, nodes, file.path, tagNodeId, 1);
      }
    }
  }

  const filteredNodes = Array.from(nodes.values()).filter((node) => node.val > 1 || hasAnyLink(links, node.id));
  const filteredNodeIds = new Set(filteredNodes.map((node) => node.id));
  const filteredLinks = Array.from(links.values()).filter((link) => {
    const source = String(link.source);
    const target = String(link.target);
    return filteredNodeIds.has(source) && filteredNodeIds.has(target);
  });
  const components = buildComponents(filteredNodes, filteredLinks);

  return {
    nodes: filteredNodes,
    links: filteredLinks,
    components
  };
}

function hasReciprocalLink(
  outgoingLinks: Record<string, Record<string, number>>,
  sourcePath: string,
  targetPath: string
): boolean {
  return outgoingLinks[targetPath]?.[sourcePath] !== undefined;
}

function addLink(
  links: Map<string, GraphLink>,
  nodes: Map<string, GraphNode>,
  source: string,
  target: string,
  count: number
): void {
  if (source === target) {
    return;
  }

  const key = `${source} -> ${target}`;
  const existing = links.get(key);

  if (existing) {
    existing.value += count;
  } else {
    links.set(key, {
      source,
      target,
      value: count
    });
  }

  const sourceNode = nodes.get(source);
  const targetNode = nodes.get(target);
  if (sourceNode) {
    sourceNode.val += count;
  }
  if (targetNode) {
    targetNode.val += count;
  }
}

function hasAnyLink(links: Map<string, GraphLink>, nodeId: string): boolean {
  for (const link of links.values()) {
    if (link.source === nodeId || link.target === nodeId) {
      return true;
    }
  }
  return false;
}

function buildComponents(nodes: GraphNode[], links: GraphLink[]): GraphComponent[] {
  const adjacency = new Map<string, Set<string>>();

  for (const node of nodes) {
    adjacency.set(node.id, new Set());
  }

  for (const link of links) {
    const source = String(link.source);
    const target = String(link.target);
    adjacency.get(source)?.add(target);
    adjacency.get(target)?.add(source);
  }

  const visited = new Set<string>();
  const components: GraphComponent[] = [];

  for (const node of nodes) {
    if (visited.has(node.id)) {
      continue;
    }

    const stack = [node.id];
    const nodeIds: string[] = [];
    visited.add(node.id);

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      nodeIds.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }

    const component: GraphComponent = {
      index: components.length,
      nodeIds,
      anchor: new Vector3()
    };
    components.push(component);
  }

  const componentByNodeId = new Map<string, number>();
  for (const component of components) {
    for (const nodeId of component.nodeIds) {
      componentByNodeId.set(nodeId, component.index);
    }
  }
  for (const node of nodes) {
    node.componentIndex = componentByNodeId.get(node.id) ?? 0;
  }

  return components;
}

function getGraphSphereRadius(nodes: GraphNode[]): number {
  return Math.max(120, Math.sqrt(nodes.length) * 34);
}

function seedNodePositions(nodes: GraphNode[], components: GraphComponent[], componentSpread: number): void {
  const radius = getGraphSphereRadius(nodes);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  nodes.forEach((node, index) => {
    const y = 1 - (index / Math.max(1, nodes.length - 1)) * 2;
    const ringRadius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = goldenAngle * index;
    const depth = 0.22 + 0.78 * Math.cbrt((index + 0.5) / Math.max(1, nodes.length));

    node.x = Math.cos(theta) * ringRadius * radius * depth;
    node.y = y * radius * depth;
    node.z = Math.sin(theta) * ringRadius * radius * depth;
  });

  const componentRadius = Math.max(20, Math.sqrt(components.length) * 150 * componentSpread);

  components.forEach((component, index) => {
    if (components.length === 1) {
      component.anchor.set(0, 0, 0);
      return;
    }

    const y = 1 - (index / Math.max(1, components.length - 1)) * 2;
    const ringRadius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = goldenAngle * index;
    component.anchor.set(
      Math.cos(theta) * ringRadius * componentRadius,
      y * componentRadius,
      Math.sin(theta) * ringRadius * componentRadius
    );
  });
}

function createComponentSpreadForce(components: GraphComponent[]): (alpha: number) => void {
  let nodes: GraphNode[] = [];
  const strength = 0.055;

  const force = (alpha: number): void => {
    for (const node of nodes) {
      const component = components[node.componentIndex ?? 0];
      if (!component) {
        continue;
      }

      node.vx = (node.vx ?? 0) + (component.anchor.x - (node.x ?? 0)) * strength * alpha;
      node.vy = (node.vy ?? 0) + (component.anchor.y - (node.y ?? 0)) * strength * alpha;
      node.vz = (node.vz ?? 0) + (component.anchor.z - (node.z ?? 0)) * strength * alpha;
    }
  };

  force.initialize = (initializedNodes: GraphNode[]): void => {
    nodes = initializedNodes;
  };

  return force;
}

function createSphericalVolumeForce(
  graphNodes: GraphNode[],
  radius: number,
  strength: number
): (alpha: number) => void {
  let nodes: GraphNode[] = [];
  const maxConnectivity = Math.max(...graphNodes.map((node) => Math.log1p(node.val)), 1);
  const targetRadiusById = new Map<string, number>();

  for (const node of graphNodes) {
    const connectivity = Math.log1p(node.val) / maxConnectivity;
    const coreBias = Math.pow(connectivity, 0.72);
    const minRadius = radius * 0.16;
    const targetRadius = radius * (0.95 - coreBias * 0.72);
    targetRadiusById.set(node.id, Math.max(minRadius, targetRadius));
  }

  const force = (alpha: number): void => {
    const pull = strength * alpha;
    const boundaryPull = Math.max(pull, strength * 0.12);

    for (const node of nodes) {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const z = node.z ?? 0;
      const distance = Math.sqrt(x * x + y * y + z * z) || 1;
      const targetRadius = targetRadiusById.get(node.id) ?? radius * 0.7;
      const targetX = (x / distance) * targetRadius;
      const targetY = (y / distance) * targetRadius;
      const targetZ = (z / distance) * targetRadius;

      node.vx = (node.vx ?? 0) + (targetX - x) * pull;
      node.vy = (node.vy ?? 0) + (targetY - y) * pull;
      node.vz = (node.vz ?? 0) + (targetZ - z) * pull;

      if (distance > radius) {
        const boundaryX = (x / distance) * radius;
        const boundaryY = (y / distance) * radius;
        const boundaryZ = (z / distance) * radius;
        node.vx += (boundaryX - x) * boundaryPull;
        node.vy += (boundaryY - y) * boundaryPull;
        node.vz += (boundaryZ - z) * boundaryPull;
      }
    }
  };

  force.initialize = (initializedNodes: GraphNode[]): void => {
    nodes = initializedNodes;
  };

  return force;
}

function resolveThemeColor(rawColor: string, fallback: string): string {
  const color = rawColor.trim();

  if (!color || color.includes("var(")) {
    return fallback;
  }

  return color;
}

function createShadedNodeTexture(color: string): Texture {
  const canvas = document.createElement("canvas");
  const size = 128;
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");
  if (!context) {
    const texture = new Texture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  const base = new Color(color).multiplyScalar(0.8);
  const baseStyle = `#${base.getHexString()}`;
  const highlightStyle = `#${base.clone().lerp(new Color("#ffffff"), 0.72).getHexString()}`;
  const midStyle = `#${base.clone().lerp(new Color("#ffffff"), 0.14).getHexString()}`;
  const shadowStyle = `#${base.clone().multiplyScalar(0.48).getHexString()}`;

  context.fillStyle = baseStyle;
  context.fillRect(0, 0, size, size);

  const lightGradient = context.createRadialGradient(42, 34, 4, 42, 34, 82);
  lightGradient.addColorStop(0, highlightStyle);
  lightGradient.addColorStop(0.22, midStyle);
  lightGradient.addColorStop(0.68, baseStyle);
  lightGradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  context.fillStyle = lightGradient;
  context.fillRect(0, 0, size, size);

  const shadowGradient = context.createRadialGradient(88, 94, 2, 88, 94, 92);
  shadowGradient.addColorStop(0, "rgba(0, 0, 0, 0.24)");
  shadowGradient.addColorStop(0.48, "rgba(0, 0, 0, 0.12)");
  shadowGradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = shadowGradient;
  context.fillRect(0, 0, size, size);

  const rimGradient = context.createRadialGradient(64, 64, 42, 64, 64, 68);
  rimGradient.addColorStop(0, "rgba(0, 0, 0, 0)");
  rimGradient.addColorStop(0.72, "rgba(0, 0, 0, 0)");
  rimGradient.addColorStop(1, shadowStyle);
  context.fillStyle = rimGradient;
  context.fillRect(0, 0, size, size);

  const texture = new Texture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function drawSmallCapsLabel(
  context: CanvasRenderingContext2D,
  text: string,
  color: string,
  width: number,
  height: number
): void {
  const words = text.toUpperCase().split(/(\s+)/);
  const maxWidth = width - 24;
  const largeSize = 48;
  const smallSize = Math.round(largeSize * 0.6);
  const fontFamily = "Inter, Segoe UI, sans-serif";
  const letterSpacing = 1;
  const segments: Array<{ value: string; fontSize: number }> = [];

  for (const word of words) {
    if (/^\s+$/.test(word)) {
      segments.push({ value: word, fontSize: smallSize });
      continue;
    }

    if (!word) {
      continue;
    }

    segments.push({ value: word.charAt(0), fontSize: largeSize });
    if (word.length > 1) {
      segments.push({ value: word.slice(1), fontSize: smallSize });
    }
  }

  const measuredWidth = measureSmallCapsSegments(context, segments, fontFamily, letterSpacing);
  const scale = Math.min(1, maxWidth / Math.max(1, measuredWidth));
  const baseline = height / 2 + largeSize * 0.24;
  let cursor = (width - measuredWidth * scale) / 2;

  context.fillStyle = color;
  context.textBaseline = "alphabetic";

  for (const segment of segments) {
    const fontSize = segment.fontSize * scale;
    context.font = `600 ${fontSize}px ${fontFamily}`;

    for (const character of segment.value) {
      const characterWidth = context.measureText(character).width;
      context.fillText(character, cursor, baseline);
      cursor += characterWidth + letterSpacing * scale;
    }
  }
}

function measureSmallCapsSegments(
  context: CanvasRenderingContext2D,
  segments: Array<{ value: string; fontSize: number }>,
  fontFamily: string,
  letterSpacing: number
): number {
  let width = 0;

  for (const segment of segments) {
    context.font = `600 ${segment.fontSize}px ${fontFamily}`;
    for (const character of segment.value) {
      width += context.measureText(character).width + letterSpacing;
    }
  }

  return Math.max(0, width - letterSpacing);
}

function getTagColor(tag: string, settings: Graph3DSettings): string {
  const explicitColor = settings.tagColors?.[tag];
  if (isHexColor(explicitColor)) {
    return explicitColor;
  }

  const parentTag = getParentTag(tag);
  if (parentTag) {
    return muteColor(getTagColor(parentTag, settings));
  }

  return DEFAULT_TAG_COLORS[getStableTagIndex(tag) % DEFAULT_TAG_COLORS.length];
}

function getParentTag(tag: string): string | null {
  const normalized = tag.startsWith("#") ? tag : `#${tag}`;
  const slashIndex = normalized.lastIndexOf("/");

  if (slashIndex <= 1) {
    return null;
  }

  return normalized.substring(0, slashIndex);
}

function getStableTagIndex(tag: string): number {
  let hash = 0;

  for (let index = 0; index < tag.length; index++) {
    hash = (hash * 31 + tag.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function muteColor(color: string): string {
  const rgb = hexToRgb(color);
  if (!rgb) {
    return "#8a8a8a";
  }

  return rgbToHex({
    r: Math.round(rgb.r * 0.62 + 138 * 0.38),
    g: Math.round(rgb.g * 0.62 + 138 * 0.38),
    b: Math.round(rgb.b * 0.62 + 138 * 0.38)
  });
}

function lightenColor(color: string, amount: number): Color {
  return new Color(color).lerp(new Color("#ffffff"), amount);
}

function isHexColor(color: string | undefined): color is string {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color);
}

function hexToRgb(color: string): { r: number; g: number; b: number } | null {
  if (!isHexColor(color)) {
    return null;
  }

  return {
    r: parseInt(color.slice(1, 3), 16),
    g: parseInt(color.slice(3, 5), 16),
    b: parseInt(color.slice(5, 7), 16)
  };
}

function rgbToHex(rgb: { r: number; g: number; b: number }): string {
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

function toHex(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
}

function updateLinkGeometry(
  geometry: BufferGeometry,
  links: GraphLink[],
  hoveredNodeId: string | undefined,
  hoverNeighbors: Set<string>,
  visibleNodeIds?: Set<string>
): void {
  const positions: number[] = [];
  const colors: number[] = [];
  const normalColor = lightenColor("#8c8c8c", 0.2);
  const highlightColor = lightenColor("#202020", 0.2);
  const dimColor = lightenColor("#b7b7b7", 0.2);

  for (const link of links) {
    const source = typeof link.source === "string" ? undefined : link.source;
    const target = typeof link.target === "string" ? undefined : link.target;
    const sourceId = typeof link.source === "string" ? link.source : link.source.id;
    const targetId = typeof link.target === "string" ? link.target : link.target.id;
    if (visibleNodeIds && (!visibleNodeIds.has(sourceId) || !visibleNodeIds.has(targetId))) {
      continue;
    }

    const isDirect = !hoveredNodeId || sourceId === hoveredNodeId || targetId === hoveredNodeId;
    const color = hoveredNodeId ? isDirect ? highlightColor : dimColor : normalColor;

    positions.push(
      source?.x ?? 0,
      source?.y ?? 0,
      source?.z ?? 0,
      target?.x ?? 0,
      target?.y ?? 0,
      target?.z ?? 0
    );
    colors.push(
      color.r,
      color.g,
      color.b,
      color.r,
      color.g,
      color.b
    );
  }

  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
}

function getDirectConnectionIds(links: GraphLink[], nodeId: string): Set<string> {
  const connectionIds = new Set<string>([nodeId]);

  for (const link of links) {
    const sourceId = typeof link.source === "string" ? link.source : link.source.id;
    const targetId = typeof link.target === "string" ? link.target : link.target.id;

    if (sourceId === nodeId) {
      connectionIds.add(targetId);
    }
    if (targetId === nodeId) {
      connectionIds.add(sourceId);
    }
  }

  return connectionIds;
}

function resolveUnresolvedLinkPath(app: App, linktext: string, sourcePath: string): string {
  const sourceFile = app.vault.getAbstractFileByPath(sourcePath);

  if (sourceFile instanceof TFile) {
    const resolved = app.metadataCache.getFirstLinkpathDest(linktext, sourceFile.path);
    if (resolved) {
      return resolved.path;
    }
  }

  const cleanLink = linktext.split("#")[0].split("|")[0].trim();
  return cleanLink.endsWith(".md") ? cleanLink : `${cleanLink}.md`;
}

function getVaultTags(app: App): string[] {
  const tags = new Set<string>();

  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    const fileTags = cache ? getAllTags(cache) : null;

    for (const tag of fileTags ?? []) {
      tags.add(tag);
    }
  }

  return Array.from(tags).sort((a, b) => a.localeCompare(b));
}

class Graph3DSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: Graph3DPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Show labels")
      .setDesc("Display note names directly in the 3D graph.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.showLabels)
        .onChange(async (value) => {
          this.plugin.settings.showLabels = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Include unresolved links")
      .setDesc("Show graph nodes for links that do not point to an existing note yet.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.includeUnresolvedLinks)
        .onChange(async (value) => {
          this.plugin.settings.includeUnresolvedLinks = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Include tags")
      .setDesc("Show tags as graph nodes connected to notes that use them.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.includeTags)
        .onChange(async (value) => {
          this.plugin.settings.includeTags = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    const tags = this.plugin.syncTagSettings();
    const tagList = containerEl.createDiv("graph-3d-tag-settings");
    tagList.toggleClass("is-disabled", !this.plugin.settings.includeTags);

    if (tags.length === 0) {
      tagList.createDiv({
        cls: "graph-3d-tag-empty",
        text: "No tags found."
      });
    } else {
      for (const tag of tags) {
        new Setting(tagList)
          .setName(tag)
          .setDesc(getParentTag(tag) && !this.plugin.settings.tagColors[tag]
            ? `Default: muted ${getParentTag(tag)}`
            : "Tag node color")
          .addColorPicker((color) => color
            .setValue(getTagColor(tag, this.plugin.settings))
            .onChange(async (value) => {
              this.plugin.settings.tagColors[tag] = value;
              await this.plugin.saveSettings();
              this.display();
            }))
          .addToggle((toggle) => toggle
            .setValue(this.plugin.settings.enabledTags[tag] !== false)
            .setDisabled(!this.plugin.settings.includeTags)
            .onChange(async (value) => {
              this.plugin.settings.enabledTags[tag] = value;
              await this.plugin.saveSettings();
            }));
      }
    }

    new Setting(containerEl)
      .setName("Show backlinks")
      .setDesc("Include one-way incoming relationships. Turn off to show only reciprocal note links.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.showBacklinks)
        .onChange(async (value) => {
          this.plugin.settings.showBacklinks = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Link distance")
      .setDesc("Controls how far connected notes drift apart.")
      .addSlider((slider) => slider
        .setLimits(20, 180, 5)
        .setDynamicTooltip()
        .setValue(this.plugin.settings.linkDistance)
        .onChange(async (value) => {
          this.plugin.settings.linkDistance = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Disconnected group spread")
      .setDesc("Controls spacing between separate linked groups without changing link distance inside a group.")
      .addSlider((slider) => slider
        .setLimits(0.1, 1, 0.01)
        .setDynamicTooltip()
        .setValue(this.plugin.settings.componentSpread)
        .onChange(async (value) => {
          this.plugin.settings.componentSpread = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Spherical constraint")
      .setDesc("Keep the graph arranged as a core-to-surface 3D volume.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.constrainToSphere)
        .onChange(async (value) => {
          this.plugin.settings.constrainToSphere = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName("Sphere strength")
      .setDesc("Controls how strongly nodes are pulled into the globe volume.")
      .addSlider((slider) => slider
        .setLimits(0.01, 1, 0.01)
        .setDynamicTooltip()
        .setDisabled(!this.plugin.settings.constrainToSphere)
        .setValue(this.plugin.settings.sphereStrength)
        .onChange(async (value) => {
          this.plugin.settings.sphereStrength = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Node size")
      .setDesc("Controls the visual weight of notes in the graph.")
      .addSlider((slider) => slider
        .setLimits(1, 12, 1)
        .setDynamicTooltip()
        .setValue(this.plugin.settings.nodeSize)
        .onChange(async (value) => {
          this.plugin.settings.nodeSize = value;
          await this.plugin.saveSettings();
        }));
  }
}
