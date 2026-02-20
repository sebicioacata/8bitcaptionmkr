import { CaptionRenderer } from "./renderer.js";
import { MiniTimeline } from "./timeline.js";
import {
  clamp,
  escapeHtml,
  formatAspectRatio,
  formatTime,
  parseNumber,
  roundToHundredths,
  sanitizeFileName
} from "./utils.js";

const LOCAL_STATE_KEY = "8bitcaptionmaker:draft:v1";
const LOCAL_SAVE_DEBOUNCE_MS = 200;
const MAX_UNDO_STEPS = 60;
// Cross-platform safe insets tuned to avoid overlays without pushing dialogue too high.
const PLATFORM_SAFE_INSETS = Object.freeze({
  left: 65 / 1080,
  right: 192 / 1080,
  top: 240 / 1920,
  bottom: 520 / 1920
});

export class CaptionMakerApp {
  constructor() {
    this.refs = this.collectRefs();
    this.state = {
      captions: [],
      nextCaptionId: 1,
      sourceObjectUrl: null,
      renderObjectUrl: null,
      previewRaf: 0,
      exportRaf: 0,
      isExporting: false,
      cancelExportRequested: false,
      cancelExportResolve: null,
      exportRecorder: null,
      currentFileName: "caption_track",
      outputWidth: 1080,
      outputHeight: 1920,
      editingCaptionId: null,
      selectedCaptionId: null,
      loopPreviewEnabled: false,
      loopRegion: null,
      restoredDraft: false,
      undoStack: [],
      isApplyingUndo: false,
      timelineUndoCueId: null,
      previewDrag: null,
      exportAudioContext: null,
      exportAudioSourceNode: null,
      exportAudioDestinationNode: null,
      exportRunId: 0,
      lastAutoDownloadedRunId: 0,
      dialoguePositionX: null,
      dialoguePositionY: null
    };
    this.localSaveTimer = null;

    this.renderer = new CaptionRenderer({
      video: this.refs.sourceVideo,
      previewCanvas: this.refs.previewCanvas,
      getStyle: () => this.getCaptionStyle(),
      getCaptions: () => this.state.captions,
      getSelectedCueId: () => this.state.selectedCaptionId,
      getEditableCueId: () => this.state.editingCaptionId
    });

    this.timeline = new MiniTimeline({
      container: this.refs.miniTimeline,
      getDuration: () => this.getVideoDuration(),
      getCurrentTime: () => this.refs.sourceVideo.currentTime || 0,
      getCaptions: () => this.state.captions,
      getSelectedCueId: () => this.state.selectedCaptionId,
      formatTime,
      onCueChange: (change) => this.handleTimelineCueChange(change),
      onCueSelect: (id) => this.selectCaption(id),
      onSeek: async (time, options = {}) => this.handleTimelineSeek(time, options)
    });
  }

  // Collect and cache all DOM references used by the app.
  collectRefs() {
    return {
      videoInput: document.getElementById("videoInput"),
      sourceVideo: document.getElementById("sourceVideo"),
      previewCanvas: document.getElementById("previewCanvas"),
      previewPanel: document.querySelector(".preview-panel"),
      chooseVideoBtn: document.getElementById("chooseVideoBtn"),
      openVideoPickerBtn: document.getElementById("openVideoPickerBtn"),
      videoMeta: document.getElementById("videoMeta"),
      durationLabel: document.getElementById("durationLabel"),
      currentTimeLabel: document.getElementById("currentTimeLabel"),
      miniTimeline: document.getElementById("miniTimeline"),
      seekBar: document.getElementById("seekBar"),
      fullscreenSeekBar: document.getElementById("fullscreenSeekBar"),
      playPauseBtn: document.getElementById("playPauseBtn"),
      muteToggleBtn: document.getElementById("muteToggleBtn"),
      loopToggleBtn: document.getElementById("loopToggleBtn"),
      fullscreenCornerBtn: document.getElementById("fullscreenCornerBtn"),
      fullscreenExitBtn: document.getElementById("fullscreenExitBtn"),
      captionText: document.getElementById("captionText"),
      captionMode: document.getElementById("captionMode"),
      cueInstantShow: document.getElementById("cueInstantShow"),
      cueTextOnly: document.getElementById("cueTextOnly"),
      cueModeHint: document.getElementById("cueModeHint"),
      captionStart: document.getElementById("captionStart"),
      captionEnd: document.getElementById("captionEnd"),
      setStartBtn: document.getElementById("setStartBtn"),
      setEndBtn: document.getElementById("setEndBtn"),
      addCaptionBtn: document.getElementById("addCaptionBtn"),
      cancelEditBtn: document.getElementById("cancelEditBtn"),
      clearCaptionsBtn: document.getElementById("clearCaptionsBtn"),
      exportCuesBtn: document.getElementById("exportCuesBtn"),
      importCuesBtn: document.getElementById("importCuesBtn"),
      importCuesInput: document.getElementById("importCuesInput"),
      captionList: document.getElementById("captionList"),
      pixelScale: document.getElementById("pixelScale"),
      pixelScaleValue: document.getElementById("pixelScaleValue"),
      fontSize: document.getElementById("fontSize"),
      textPixelation: document.getElementById("textPixelation"),
      textPixelationValue: document.getElementById("textPixelationValue"),
      boxWidth: document.getElementById("boxWidth"),
      boxStyle: document.getElementById("boxStyle"),
      bottomOffset: document.getElementById("bottomOffset"),
      usePlatformSafeArea: document.getElementById("usePlatformSafeArea"),
      manualDialoguePosition: document.getElementById("manualDialoguePosition"),
      textColor: document.getElementById("textColor"),
      chromaColor: document.getElementById("chromaColor"),
      animationStyle: document.getElementById("animationStyle"),
      animationDuration: document.getElementById("animationDuration"),
      formatPreset: document.getElementById("formatPreset"),
      outputResolution: document.getElementById("outputResolution"),
      outputMode: document.getElementById("outputMode"),
      exportFps: document.getElementById("exportFps"),
      exportContainer: document.getElementById("exportContainer"),
      includeAudio: document.getElementById("includeAudio"),
      muteSourcePreview: document.getElementById("muteSourcePreview"),
      renderBtn: document.getElementById("renderBtn"),
      renderStatus: document.getElementById("renderStatus"),
      downloadLink: document.getElementById("downloadLink")
    };
  }

  init() {
    this.restoreLocalState();
    this.syncOutputCanvasSize();
    this.updatePixelScaleLabel();
    this.updateTextPixelationLabel();
    this.refreshCaptionList();
    this.updateCueModeUi();
    this.updateCueActionButtons();
    this.setStatus(this.state.restoredDraft ? "Draft restored. Re-select source video to preview/export." : "Idle");
    this.renderer.drawPreviewFrame();
    this.bindEvents();

    this.refs.sourceVideo.muted = this.refs.muteSourcePreview.checked;
    this.updateMuteButtonState();
    this.updateLoopButtonState();
    this.updateFullscreenUiState();
    this.timeline.render();
  }

  setStatus(message) {
    this.refs.renderStatus.textContent = message;
  }

  updateMuteButtonState() {
    const muted = !!this.refs.muteSourcePreview.checked;
    this.refs.muteToggleBtn.textContent = muted ? "Mute On" : "Mute Off";
    this.refs.muteToggleBtn.classList.toggle("is-active", muted);
  }

  updateLoopButtonState() {
    const enabled = !!this.state.loopPreviewEnabled;
    this.refs.loopToggleBtn.textContent = enabled ? "Loop On" : "Loop Off";
    this.refs.loopToggleBtn.classList.toggle("is-active", enabled);
  }

  updateFullscreenUiState() {
    const isFullscreen = document.fullscreenElement === this.refs.previewPanel;
    document.body.classList.toggle("is-preview-fullscreen", isFullscreen);
    this.refs.fullscreenExitBtn.parentElement?.setAttribute("aria-hidden", isFullscreen ? "false" : "true");
    this.refs.fullscreenCornerBtn.setAttribute(
      "title",
      isFullscreen ? "Exit fullscreen preview" : "Fullscreen preview"
    );
  }

  toggleMute() {
    this.refs.muteSourcePreview.checked = !this.refs.muteSourcePreview.checked;
    if (!this.state.isExporting) {
      this.refs.sourceVideo.muted = this.refs.muteSourcePreview.checked;
    }
    this.updateMuteButtonState();
    this.scheduleLocalSave();
  }

  toggleLoopPreview() {
    this.state.loopPreviewEnabled = !this.state.loopPreviewEnabled;
    if (!this.state.loopPreviewEnabled) {
      this.state.loopRegion = null;
    } else {
      this.state.loopRegion = this.resolveLoopRegion(this.refs.sourceVideo.currentTime || 0);
    }
    this.updateLoopButtonState();
    this.scheduleLocalSave();
  }

  parseOptionalPercent(value, min = 0, max = 100) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return clamp(parsed, min, max);
  }

  getSanitizedLocalCaptions(captions) {
    if (!Array.isArray(captions)) {
      return [];
    }

    const sanitized = [];
    for (const entry of captions) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const rawText = typeof entry.text === "string" ? entry.text : "";
      const text = rawText.trim();
      if (!text) {
        continue;
      }

      const id = Math.max(1, Math.round(parseNumber(entry.id, sanitized.length + 1)));
      const start = Math.max(0, parseNumber(entry.start, 0));
      const rawEnd = Math.max(0, parseNumber(entry.end, start + 2));
      const end = Math.max(start + 0.1, rawEnd);

      sanitized.push({
        id,
        text,
        start: roundToHundredths(start),
        end: roundToHundredths(end),
        mode: this.normalizeCueMode(entry.mode),
        instantShow: !!entry.instantShow,
        textOnly: !!entry.textOnly,
        positionX: this.parseOptionalPercent(entry.positionX, 0, 100),
        positionY: this.parseOptionalPercent(entry.positionY, 0, 100),
        boxWidthPercent: this.parseOptionalPercent(entry.boxWidthPercent, 20, 95),
        boxHeightPercent: this.parseOptionalPercent(entry.boxHeightPercent, 6, 80)
      });
    }

    sanitized.sort((a, b) => a.start - b.start);
    return sanitized;
  }

  // Local draft persistence (form + style + cues).
  collectLocalState() {
    return {
      version: 1,
      savedAt: Date.now(),
      currentFileName: this.state.currentFileName,
      captions: this.state.captions.map((caption) => ({
        id: caption.id,
        text: caption.text,
        start: caption.start,
        end: caption.end,
        mode: this.normalizeCueMode(caption.mode),
        instantShow: !!caption.instantShow,
        textOnly: !!caption.textOnly,
        positionX: Number.isFinite(caption.positionX) ? caption.positionX : null,
        positionY: Number.isFinite(caption.positionY) ? caption.positionY : null,
        boxWidthPercent: Number.isFinite(caption.boxWidthPercent) ? caption.boxWidthPercent : null,
        boxHeightPercent: Number.isFinite(caption.boxHeightPercent) ? caption.boxHeightPercent : null
      })),
      form: {
        captionText: this.refs.captionText.value,
        captionStart: this.refs.captionStart.value,
        captionEnd: this.refs.captionEnd.value,
        captionMode: this.normalizeCueMode(this.refs.captionMode.value),
        cueInstantShow: !!this.refs.cueInstantShow.checked,
        cueTextOnly: !!this.refs.cueTextOnly.checked
      },
      style: {
        pixelScale: this.refs.pixelScale.value,
        fontSize: this.refs.fontSize.value,
        textPixelation: this.refs.textPixelation.value,
        boxWidth: this.refs.boxWidth.value,
        boxStyle: this.refs.boxStyle.value,
        bottomOffset: this.refs.bottomOffset.value,
        usePlatformSafeArea: !!this.refs.usePlatformSafeArea.checked,
        manualDialoguePosition: !!this.refs.manualDialoguePosition.checked,
        dialoguePositionX: Number.isFinite(this.state.dialoguePositionX) ? this.state.dialoguePositionX : null,
        dialoguePositionY: Number.isFinite(this.state.dialoguePositionY) ? this.state.dialoguePositionY : null,
        textColor: this.refs.textColor.value,
        chromaColor: this.refs.chromaColor.value,
        animationStyle: this.refs.animationStyle.value,
        animationDuration: this.refs.animationDuration.value,
        formatPreset: this.refs.formatPreset.value,
        outputMode: this.refs.outputMode.value,
        exportFps: this.refs.exportFps.value,
        exportContainer: this.refs.exportContainer.value,
        includeAudio: !!this.refs.includeAudio.checked,
        muteSourcePreview: !!this.refs.muteSourcePreview.checked,
        loopPreviewEnabled: !!this.state.loopPreviewEnabled
      }
    };
  }

  saveLocalState() {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }

    try {
      window.localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(this.collectLocalState()));
    } catch (error) {
      console.warn("Unable to save local draft:", error);
    }
  }

  scheduleLocalSave() {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }

    if (this.localSaveTimer) {
      window.clearTimeout(this.localSaveTimer);
    }

    this.localSaveTimer = window.setTimeout(() => {
      this.localSaveTimer = null;
      this.saveLocalState();
    }, LOCAL_SAVE_DEBOUNCE_MS);
  }

  restoreLocalState() {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }

    try {
      const raw = window.localStorage.getItem(LOCAL_STATE_KEY);
      if (!raw) {
        return;
      }

      const snapshot = JSON.parse(raw);
      if (!snapshot || typeof snapshot !== "object") {
        return;
      }

      this.state.captions = this.getSanitizedLocalCaptions(snapshot.captions);
      const maxId = this.state.captions.reduce((acc, caption) => Math.max(acc, caption.id), 0);
      this.state.nextCaptionId = maxId + 1;

      if (typeof snapshot.currentFileName === "string" && snapshot.currentFileName.trim()) {
        this.state.currentFileName = sanitizeFileName(snapshot.currentFileName) || "caption_track";
      }

      if (snapshot.form && typeof snapshot.form === "object") {
        this.refs.captionText.value = typeof snapshot.form.captionText === "string" ? snapshot.form.captionText : "";
        this.refs.captionStart.value = typeof snapshot.form.captionStart === "string" ? snapshot.form.captionStart : "0";
        this.refs.captionEnd.value =
          typeof snapshot.form.captionEnd === "string" ? snapshot.form.captionEnd : this.refs.captionEnd.value;
        this.refs.captionMode.value = this.normalizeCueMode(snapshot.form.captionMode);
        this.refs.cueInstantShow.checked = !!snapshot.form.cueInstantShow;
        this.refs.cueTextOnly.checked = !!snapshot.form.cueTextOnly;
      }

      if (snapshot.style && typeof snapshot.style === "object") {
        this.refs.pixelScale.value = snapshot.style.pixelScale || this.refs.pixelScale.value;
        this.refs.fontSize.value = snapshot.style.fontSize || this.refs.fontSize.value;
        this.refs.textPixelation.value = snapshot.style.textPixelation || this.refs.textPixelation.value;
        this.refs.boxWidth.value = snapshot.style.boxWidth || this.refs.boxWidth.value;
        this.refs.boxStyle.value = snapshot.style.boxStyle || this.refs.boxStyle.value;
        this.refs.bottomOffset.value = snapshot.style.bottomOffset || this.refs.bottomOffset.value;
        if (typeof snapshot.style.usePlatformSafeArea === "boolean") {
          this.refs.usePlatformSafeArea.checked = snapshot.style.usePlatformSafeArea;
        }
        if (typeof snapshot.style.manualDialoguePosition === "boolean") {
          this.refs.manualDialoguePosition.checked = snapshot.style.manualDialoguePosition;
        }
        this.state.dialoguePositionX = this.parseOptionalPercent(snapshot.style.dialoguePositionX, 0, 100);
        this.state.dialoguePositionY = this.parseOptionalPercent(snapshot.style.dialoguePositionY, 0, 100);
        this.refs.textColor.value = snapshot.style.textColor || this.refs.textColor.value;
        this.refs.chromaColor.value = snapshot.style.chromaColor || this.refs.chromaColor.value;
        this.refs.animationStyle.value = snapshot.style.animationStyle || this.refs.animationStyle.value;
        this.refs.animationDuration.value = snapshot.style.animationDuration || this.refs.animationDuration.value;
        this.refs.formatPreset.value = snapshot.style.formatPreset || this.refs.formatPreset.value;
        this.refs.outputMode.value = snapshot.style.outputMode || this.refs.outputMode.value;
        this.refs.exportFps.value = snapshot.style.exportFps || this.refs.exportFps.value;
        this.refs.exportContainer.value = snapshot.style.exportContainer || this.refs.exportContainer.value;
        this.refs.includeAudio.checked = !!snapshot.style.includeAudio;
        this.refs.muteSourcePreview.checked = !!snapshot.style.muteSourcePreview;
        this.state.loopPreviewEnabled = !!snapshot.style.loopPreviewEnabled;
      }

      this.state.restoredDraft = this.state.captions.length > 0 || !!snapshot.form || !!snapshot.style;
    } catch (error) {
      console.warn("Unable to restore local draft:", error);
    }
  }

  buildCueTransferPayload() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      sourceFileName: this.state.currentFileName,
      cues: this.state.captions.map((caption) => ({
        id: caption.id,
        text: caption.text,
        start: caption.start,
        end: caption.end,
        mode: this.normalizeCueMode(caption.mode),
        instantShow: !!caption.instantShow,
        textOnly: !!caption.textOnly,
        positionX: Number.isFinite(caption.positionX) ? caption.positionX : null,
        positionY: Number.isFinite(caption.positionY) ? caption.positionY : null,
        boxWidthPercent: Number.isFinite(caption.boxWidthPercent) ? caption.boxWidthPercent : null,
        boxHeightPercent: Number.isFinite(caption.boxHeightPercent) ? caption.boxHeightPercent : null
      }))
    };
  }

  exportCuesToFile() {
    if (!this.state.captions.length) {
      window.alert("No cues to export yet.");
      return;
    }

    const payload = this.buildCueTransferPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `${this.state.currentFileName || "caption_track"}_cues.json`;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
    this.setStatus(`Exported ${payload.cues.length} cue${payload.cues.length === 1 ? "" : "s"} to JSON.`);
  }

  getCueEntriesFromImportPayload(payload) {
    if (Array.isArray(payload)) {
      return payload;
    }
    if (!payload || typeof payload !== "object") {
      return [];
    }
    if (Array.isArray(payload.cues)) {
      return payload.cues;
    }
    if (Array.isArray(payload.captions)) {
      return payload.captions;
    }
    return [];
  }

  async importCuesFromFile(file) {
    if (!file) {
      return;
    }

    let parsed = null;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch (error) {
      console.warn("Unable to parse imported cue JSON:", error);
      window.alert("Invalid cue JSON file.");
      return;
    }

    const importedEntries = this.getCueEntriesFromImportPayload(parsed);
    const sanitizedCues = this.getSanitizedLocalCaptions(importedEntries);
    if (!sanitizedCues.length) {
      window.alert("No valid cues found in that file.");
      return;
    }

    this.pushUndoSnapshot();
    this.state.captions = sanitizedCues;
    const maxId = this.state.captions.reduce((acc, caption) => Math.max(acc, caption.id), 0);
    this.state.nextCaptionId = maxId + 1;
    this.state.selectedCaptionId = null;
    this.state.editingCaptionId = null;
    this.updateCueActionButtons();
    this.refreshCaptionList();
    this.renderer.drawPreviewFrame();
    this.scheduleLocalSave();
    this.setStatus(`Imported ${sanitizedCues.length} cue${sanitizedCues.length === 1 ? "" : "s"} from JSON.`);
  }

  cloneCaptions(captions) {
    return captions.map((caption) => ({ ...caption }));
  }

  pushUndoSnapshot() {
    if (this.state.isApplyingUndo) {
      return;
    }

    const snapshot = {
      captions: this.cloneCaptions(this.state.captions),
      nextCaptionId: this.state.nextCaptionId,
      selectedCaptionId: this.state.selectedCaptionId,
      editingCaptionId: this.state.editingCaptionId,
      style: {
        dialoguePositionX: this.state.dialoguePositionX,
        dialoguePositionY: this.state.dialoguePositionY
      },
      form: {
        captionText: this.refs.captionText.value,
        captionStart: this.refs.captionStart.value,
        captionEnd: this.refs.captionEnd.value,
        captionMode: this.normalizeCueMode(this.refs.captionMode.value),
        cueInstantShow: !!this.refs.cueInstantShow.checked,
        cueTextOnly: !!this.refs.cueTextOnly.checked
      }
    };

    this.state.undoStack.push(snapshot);
    if (this.state.undoStack.length > MAX_UNDO_STEPS) {
      this.state.undoStack.shift();
    }
  }

  undoLastAction() {
    if (!this.state.undoStack.length) {
      this.setStatus("Nothing to undo.");
      return;
    }

    const snapshot = this.state.undoStack.pop();
    this.state.isApplyingUndo = true;

    this.state.captions = this.cloneCaptions(snapshot.captions || []);
    this.state.nextCaptionId = Math.max(1, parseNumber(snapshot.nextCaptionId, 1));
    this.state.selectedCaptionId = snapshot.selectedCaptionId || null;
    this.state.editingCaptionId = snapshot.editingCaptionId || null;
    this.state.timelineUndoCueId = null;
    this.state.previewDrag = null;
    this.state.dialoguePositionX = Number.isFinite(snapshot.style?.dialoguePositionX)
      ? clamp(snapshot.style.dialoguePositionX, 0, 100)
      : null;
    this.state.dialoguePositionY = Number.isFinite(snapshot.style?.dialoguePositionY)
      ? clamp(snapshot.style.dialoguePositionY, 0, 100)
      : null;

    const form = snapshot.form || {};
    this.refs.captionText.value = typeof form.captionText === "string" ? form.captionText : "";
    this.refs.captionStart.value = typeof form.captionStart === "string" ? form.captionStart : this.refs.captionStart.value;
    this.refs.captionEnd.value = typeof form.captionEnd === "string" ? form.captionEnd : this.refs.captionEnd.value;
    this.refs.captionMode.value = this.normalizeCueMode(form.captionMode);
    this.refs.cueInstantShow.checked = !!form.cueInstantShow;
    this.refs.cueTextOnly.checked = !!form.cueTextOnly;
    this.updateCueModeUi();
    this.updateCueActionButtons();

    this.refreshCaptionList();
    this.renderer.drawPreviewFrame();
    this.state.isApplyingUndo = false;
    this.scheduleLocalSave();
    this.setStatus("Undid last action.");
  }

  ensureEndAfterStart(startValue, endValue, preferredSpan = 2) {
    const duration = this.getVideoDuration() || Number.POSITIVE_INFINITY;
    const minGap = 0.1;
    const minEnd = startValue + minGap;
    const candidateEnd = endValue <= startValue ? startValue + preferredSpan : endValue;
    return clamp(candidateEnd, minEnd, duration);
  }

  syncFormEndWithStart() {
    const start = parseNumber(this.refs.captionStart.value, 0);
    const end = parseNumber(this.refs.captionEnd.value, start + 2);
    const syncedEnd = this.ensureEndAfterStart(start, end, 2);
    this.refs.captionEnd.value = String(roundToHundredths(syncedEnd));
  }

  getVideoDuration() {
    return Number.isFinite(this.refs.sourceVideo.duration) ? this.refs.sourceVideo.duration : 0;
  }

  getPixelScale() {
    return clamp(Math.round(parseNumber(this.refs.pixelScale.value, 4)), 2, 12);
  }

  getCaptionStyle() {
    return {
      pixelScale: this.getPixelScale(),
      fontSize: clamp(Math.round(parseNumber(this.refs.fontSize.value, 12)), 6, 30),
      textPixelation: clamp(parseNumber(this.refs.textPixelation.value, 1), 0.5, 2.4),
      boxWidthPercent: clamp(parseNumber(this.refs.boxWidth.value, 85), 40, 95),
      boxStyle: this.refs.boxStyle.value,
      bottomOffset: clamp(parseNumber(this.refs.bottomOffset.value, 100), 4, 400),
      usePlatformSafeArea: !!this.refs.usePlatformSafeArea.checked,
      manualDialoguePosition: !!this.refs.manualDialoguePosition.checked,
      dialoguePositionX: Number.isFinite(this.state.dialoguePositionX) ? this.state.dialoguePositionX : null,
      dialoguePositionY: Number.isFinite(this.state.dialoguePositionY) ? this.state.dialoguePositionY : null,
      textColor: this.refs.textColor.value,
      chromaColor: this.refs.chromaColor.value,
      animationStyle: this.refs.animationStyle.value,
      animationDuration: clamp(parseNumber(this.refs.animationDuration.value, 0.3), 0.05, 1)
    };
  }

  getOutputDimensions() {
    if (this.refs.formatPreset.value === "source" && this.refs.sourceVideo.videoWidth && this.refs.sourceVideo.videoHeight) {
      return {
        width: this.refs.sourceVideo.videoWidth,
        height: this.refs.sourceVideo.videoHeight
      };
    }

    return { width: 1080, height: 1920 };
  }

  syncOutputCanvasSize() {
    const dimensions = this.getOutputDimensions();
    this.state.outputWidth = dimensions.width;
    this.state.outputHeight = dimensions.height;

    this.renderer.setPreviewSize(dimensions.width, dimensions.height);
    this.refs.outputResolution.textContent = `Output: ${dimensions.width}x${dimensions.height} (${formatAspectRatio(dimensions.width, dimensions.height)})`;
  }

  updatePixelScaleLabel() {
    this.refs.pixelScaleValue.textContent = `${this.getPixelScale()}x`;
  }

  updateTextPixelationLabel() {
    const value = clamp(parseNumber(this.refs.textPixelation.value, 1), 0.5, 2.4);
    this.refs.textPixelationValue.textContent = `${value.toFixed(1)}x`;
  }

  updateCurrentTimeLabel() {
    this.refs.currentTimeLabel.textContent = formatTime(this.refs.sourceVideo.currentTime || 0);
  }

  updateSeekBar() {
    if (!this.getVideoDuration()) {
      this.refs.seekBar.value = "0";
      this.refs.fullscreenSeekBar.value = "0";
      this.timeline.updatePlayhead();
      return;
    }

    const value = String(this.refs.sourceVideo.currentTime || 0);
    this.refs.seekBar.value = value;
    this.refs.fullscreenSeekBar.value = value;
    this.timeline.updatePlayhead();
  }

  async seekPreviewTo(seconds, options = {}) {
    if (!this.getVideoDuration()) {
      return;
    }

    this.refs.sourceVideo.pause();
    await this.seekVideo(seconds);
    this.updateCurrentTimeLabel();
    this.updateSeekBar();
    this.renderer.drawPreviewFrame();

    if (this.state.loopPreviewEnabled && !options.scrubbing) {
      const loopRegion = this.resolveLoopRegion(seconds);
      await this.autoplayLoopRegion(loopRegion);
    }
  }

  async jumpToStart() {
    if (!this.getVideoDuration()) {
      return;
    }
    await this.seekPreviewTo(0);
  }

  normalizeCueMode(mode) {
    if (mode === "choice" || mode === "dramatic") {
      return mode;
    }
    return "dialogue";
  }

  cueModeLabel(mode) {
    if (mode === "choice") {
      return "Action";
    }
    if (mode === "dramatic") {
      return "Dramatic";
    }
    return "Dialogue";
  }

  defaultCueText(mode) {
    if (mode === "choice") {
      return "What will you do?\n\n>Call back\nGo to her\nLet her go";
    }
    if (mode === "dramatic") {
      return "Bye.";
    }
    return "New dialogue...";
  }

  updateCueModeUi() {
    const mode = this.normalizeCueMode(this.refs.captionMode.value);
    this.refs.captionMode.value = mode;

    if (mode === "dialogue") {
      this.refs.cueModeHint.innerHTML = "Classic boxed dialogue with prompt triangle.";
    } else if (mode === "choice") {
      this.refs.cueModeHint.innerHTML =
        "Choice format: prompt, blank line, then options; prefix selected option with <code>&gt;</code>.";
    } else {
      this.refs.cueModeHint.innerHTML = "Dramatic text uses large centered typography; toggle text-only for no backdrop band.";
    }

    const textOnlyAvailable = mode === "dramatic";
    this.refs.cueTextOnly.disabled = !textOnlyAvailable;
    if (!textOnlyAvailable) {
      this.refs.cueTextOnly.checked = false;
    }
  }

  createCaption({ text, start, end, mode, instantShow, textOnly }) {
    const duration = this.getVideoDuration();
    if (!duration) {
      window.alert("Load a source video before adding dialogue cues.");
      return null;
    }

    const trimmedText = (text || "").trim();
    if (!trimmedText) {
      window.alert("Enter dialogue text first.");
      return null;
    }

    const boundedStart = clamp(start, 0, duration);
    const boundedEnd = clamp(this.ensureEndAfterStart(boundedStart, end, 2), 0, duration);

    if (boundedEnd <= boundedStart) {
      window.alert("Your cue is outside the loaded video duration.");
      return null;
    }

    this.pushUndoSnapshot();
    const caption = {
      id: this.state.nextCaptionId,
      text: trimmedText,
      start: boundedStart,
      end: boundedEnd,
      mode: this.normalizeCueMode(mode),
      instantShow: !!instantShow,
      textOnly: !!textOnly,
      positionX: null,
      positionY: null,
      boxWidthPercent: null,
      boxHeightPercent: null
    };

    this.state.captions.push(caption);
    this.state.nextCaptionId += 1;
    this.state.captions.sort((a, b) => a.start - b.start);
    this.state.selectedCaptionId = caption.id;
    this.scheduleLocalSave();
    return caption;
  }

  selectCaption(captionId, { syncForm = false, focusText = false } = {}) {
    const caption = this.findCaptionById(captionId);
    if (!caption) {
      return;
    }

    this.state.selectedCaptionId = caption.id;
    if (syncForm) {
      this.populateCueFormFromCaption(caption);
    }
    this.refreshCaptionList();
    if (focusText) {
      this.refs.captionText.focus();
      this.refs.captionText.select();
    }
  }

  removeCaptionById(captionId) {
    const beforeCount = this.state.captions.length;
    if (!this.state.captions.some((entry) => entry.id === captionId)) {
      return false;
    }
    this.pushUndoSnapshot();
    this.state.captions = this.state.captions.filter((entry) => entry.id !== captionId);
    if (this.state.captions.length === beforeCount) {
      return false;
    }

    if (this.state.editingCaptionId === captionId) {
      this.state.editingCaptionId = null;
      this.updateCueActionButtons();
    }
    if (this.state.selectedCaptionId === captionId) {
      this.state.selectedCaptionId = null;
    }

    this.refreshCaptionList();
    this.renderer.drawPreviewFrame();
    this.scheduleLocalSave();
    return true;
  }

  deleteSelectedCaption() {
    if (!this.state.selectedCaptionId) {
      return;
    }
    this.removeCaptionById(this.state.selectedCaptionId);
  }

  toggleEditSelectedCaption() {
    if (!this.state.selectedCaptionId) {
      return;
    }

    this.startCueEdit(this.state.selectedCaptionId, { toggle: true, focusText: true });
  }

  populateCueFormFromCaption(caption) {
    if (!caption) {
      return;
    }

    this.refs.captionText.value = caption.text;
    this.refs.captionStart.value = caption.start.toFixed(2);
    this.refs.captionEnd.value = caption.end.toFixed(2);
    this.refs.captionMode.value = this.normalizeCueMode(caption.mode);
    this.refs.cueInstantShow.checked = !!caption.instantShow;
    this.refs.cueTextOnly.checked = !!caption.textOnly;
    this.updateCueModeUi();
  }

  updateCueActionButtons() {
    const editingCaption = this.findCaptionById(this.state.editingCaptionId);
    if (!editingCaption) {
      this.state.editingCaptionId = null;
    }
    const isEditing = !!this.state.editingCaptionId;
    this.refs.addCaptionBtn.textContent = isEditing ? "Save cue" : "Add cue";
    this.refs.cancelEditBtn.hidden = !isEditing;
  }

  startCueEdit(captionId, { toggle = false, focusText = false } = {}) {
    const caption = this.findCaptionById(captionId);
    if (!caption) {
      return;
    }

    if (toggle && this.state.editingCaptionId === caption.id) {
      this.clearCueEditMode();
      return;
    }

    this.state.selectedCaptionId = caption.id;
    this.state.editingCaptionId = caption.id;
    this.populateCueFormFromCaption(caption);
    this.updateCueActionButtons();
    this.refreshCaptionList();
    this.focusCueForEditing(caption);
    if (focusText) {
      this.refs.captionText.focus();
      this.refs.captionText.select();
    }
    this.scheduleLocalSave();
  }

  clearCueEditMode({ refresh = true, redraw = true, save = true } = {}) {
    if (!this.state.editingCaptionId) {
      this.updateCueActionButtons();
      return;
    }

    this.state.editingCaptionId = null;
    this.updateCueActionButtons();
    if (refresh) {
      this.refreshCaptionList();
    }
    if (redraw) {
      this.renderer.drawPreviewFrame();
    }
    if (save) {
      this.scheduleLocalSave();
    }
  }

  saveEditingCaptionFromForm() {
    const caption = this.findCaptionById(this.state.editingCaptionId);
    if (!caption) {
      this.clearCueEditMode();
      return false;
    }

    const duration = this.getVideoDuration();
    if (!duration) {
      window.alert("Load a source video before saving dialogue cues.");
      return false;
    }

    const trimmedText = this.refs.captionText.value.trim();
    if (!trimmedText) {
      window.alert("Enter dialogue text first.");
      return false;
    }

    const preferredSpan = Math.max(0.1, caption.end - caption.start);
    const nextStart = clamp(parseNumber(this.refs.captionStart.value, caption.start), 0, duration);
    const rawEnd = parseNumber(this.refs.captionEnd.value, caption.end);
    const nextEnd = clamp(this.ensureEndAfterStart(nextStart, rawEnd, preferredSpan), 0, duration);
    if (nextEnd <= nextStart) {
      window.alert("Your cue is outside the loaded video duration.");
      return false;
    }

    this.pushUndoSnapshot();
    caption.text = trimmedText;
    this.updateCaptionTimes(caption, nextStart, nextEnd);
    caption.mode = this.normalizeCueMode(this.refs.captionMode.value);
    caption.instantShow = !!this.refs.cueInstantShow.checked;
    caption.textOnly = caption.mode === "dramatic" ? !!this.refs.cueTextOnly.checked : false;

    this.state.captions.sort((a, b) => a.start - b.start);
    this.state.selectedCaptionId = caption.id;
    this.state.editingCaptionId = null;
    this.populateCueFormFromCaption(caption);
    this.updateCueActionButtons();
    this.refreshCaptionList();
    this.renderer.drawPreviewFrame();
    this.scheduleLocalSave();

    if (this.state.loopPreviewEnabled) {
      void this.autoplayLoopRegion({ start: caption.start, end: caption.end });
    }

    this.setStatus("Cue updated.");
    return true;
  }

  addCueAtPlayhead() {
    const duration = this.getVideoDuration();
    if (!duration) {
      return;
    }

    const mode = this.normalizeCueMode(this.refs.captionMode.value);
    const currentTime = clamp(this.refs.sourceVideo.currentTime || 0, 0, Math.max(0, duration - 0.1));
    const start = roundToHundredths(currentTime);
    const end = this.ensureEndAfterStart(start, start + 2, 2);
    const caption = this.createCaption({
      text: this.defaultCueText(mode),
      start,
      end,
      mode,
      instantShow: this.refs.cueInstantShow.checked,
      textOnly: this.refs.cueTextOnly.checked
    });

    if (!caption) {
      return;
    }

    this.startCueEdit(caption.id, { toggle: false, focusText: true });
  }

  async toggleFullscreenPreview() {
    if (!this.refs.previewPanel) {
      return;
    }

    if (document.fullscreenElement === this.refs.previewPanel) {
      await document.exitFullscreen().catch(() => {
        /* ignore */
      });
      return;
    }

    await this.refs.previewPanel.requestFullscreen().catch(() => {
      /* ignore */
    });
  }

  findCaptionById(id) {
    return this.state.captions.find((caption) => caption.id === id) || null;
  }

  updateCaptionTimes(caption, start, end) {
    caption.start = roundToHundredths(start);
    caption.end = roundToHundredths(end);
  }

  resolveLoopRegion(timeSeconds) {
    const active = this.state.captions.find((cue) => timeSeconds >= cue.start && timeSeconds <= cue.end);
    if (active) {
      return { start: active.start, end: active.end };
    }

    const duration = this.getVideoDuration();
    if (!duration) {
      return null;
    }

    const fallbackEnd = clamp(timeSeconds + 2, timeSeconds + 0.1, duration);
    return { start: clamp(timeSeconds, 0, duration), end: fallbackEnd };
  }

  applyLoopGuard() {
    if (!this.state.loopPreviewEnabled || !this.state.loopRegion || this.state.isExporting) {
      return;
    }

    const { start, end } = this.state.loopRegion;
    if (end <= start + 0.05) {
      return;
    }

    if ((this.refs.sourceVideo.currentTime || 0) >= end) {
      this.refs.sourceVideo.currentTime = start;
    }
  }

  async autoplayLoopRegion(region) {
    if (!this.state.loopPreviewEnabled || !region || this.state.isExporting) {
      return;
    }

    this.state.loopRegion = region;
    await this.seekVideo(region.start);
    this.updateCurrentTimeLabel();
    this.updateSeekBar();
    this.renderer.drawPreviewFrame();
    await this.refs.sourceVideo.play().catch(() => {
      /* ignore autoplay errors */
    });
  }

  async ensureFirstFrameReady() {
    if (this.refs.sourceVideo.readyState >= 2) {
      return;
    }

    await new Promise((resolve, reject) => {
      const onLoadedData = () => {
        this.refs.sourceVideo.removeEventListener("loadeddata", onLoadedData);
        this.refs.sourceVideo.removeEventListener("error", onError);
        resolve();
      };

      const onError = () => {
        this.refs.sourceVideo.removeEventListener("loadeddata", onLoadedData);
        this.refs.sourceVideo.removeEventListener("error", onError);
        reject(new Error("Unable to decode first frame."));
      };

      this.refs.sourceVideo.addEventListener("loadeddata", onLoadedData);
      this.refs.sourceVideo.addEventListener("error", onError);
    });
  }

  async seekVideo(seconds) {
    const duration = this.getVideoDuration();
    const target = clamp(seconds, 0, duration || seconds);

    if (Math.abs((this.refs.sourceVideo.currentTime || 0) - target) <= 0.01) {
      return;
    }

    await new Promise((resolve) => {
      const onSeeked = () => {
        this.refs.sourceVideo.removeEventListener("seeked", onSeeked);
        resolve();
      };

      this.refs.sourceVideo.addEventListener("seeked", onSeeked);
      this.refs.sourceVideo.currentTime = target;
    });
  }

  refreshCaptionList() {
    this.refs.captionList.innerHTML = "";

    if (!this.state.captions.length) {
      const empty = document.createElement("li");
      empty.className = "caption-item";
      empty.innerHTML = "<p>No dialogue cues yet.</p><span></span>";
      this.refs.captionList.appendChild(empty);
      this.timeline.render();
      return;
    }

    for (const caption of this.state.captions) {
      const item = document.createElement("li");
      item.className = `caption-item${this.state.selectedCaptionId === caption.id ? " is-selected" : ""}`;
      item.addEventListener("click", (event) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.closest("button, input, textarea, select")) {
          return;
        }
        this.selectCaption(caption.id);
      });

      const row = document.createElement("div");
      row.className = "caption-row";

      const textBlock = document.createElement("p");
      const mode = this.normalizeCueMode(caption.mode);
      const badges = [];
      if (caption.instantShow) {
        badges.push("Instant");
      }
      if (caption.textOnly && mode === "dramatic") {
        badges.push("No BG");
      }
      const badgeText = badges.length ? ` | ${badges.join(", ")}` : "";
      textBlock.innerHTML =
        `<span class="cue-mode-tag">[${this.cueModeLabel(mode)}]</span>` +
        `<span class="time">${formatTime(caption.start)} - ${formatTime(caption.end)}${badgeText}</span><br>${escapeHtml(caption.text)}`;

      const actions = document.createElement("div");
      actions.className = "caption-actions";

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "ghost-btn";
      editBtn.textContent = this.state.editingCaptionId === caption.id ? "Close" : "Edit";
      editBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.startCueEdit(caption.id, { toggle: true, focusText: true });
      });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "remove-btn";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.removeCaptionById(caption.id);
      });

      actions.appendChild(editBtn);
      actions.appendChild(removeBtn);
      row.appendChild(textBlock);
      row.appendChild(actions);
      item.appendChild(row);

      this.refs.captionList.appendChild(item);
    }

    this.timeline.render();
  }

  addCaption() {
    if (this.state.editingCaptionId) {
      this.saveEditingCaptionFromForm();
      return;
    }

    const caption = this.createCaption({
      text: this.refs.captionText.value,
      start: parseNumber(this.refs.captionStart.value, 0),
      end: parseNumber(this.refs.captionEnd.value, 0),
      mode: this.refs.captionMode.value,
      instantShow: this.refs.cueInstantShow.checked,
      textOnly: this.refs.cueTextOnly.checked
    });

    if (!caption) {
      return;
    }

    this.refs.captionText.value = "";
    this.refs.captionMode.value = this.normalizeCueMode(caption.mode);
    this.refs.cueInstantShow.checked = !!caption.instantShow;
    this.refs.cueTextOnly.checked = !!caption.textOnly;
    this.updateCueModeUi();
    this.state.editingCaptionId = null;
    this.updateCueActionButtons();
    this.refs.captionStart.value = caption.start.toFixed(2);
    this.refs.captionEnd.value = caption.end.toFixed(2);
    this.refreshCaptionList();
    this.renderer.drawPreviewFrame();
    this.scheduleLocalSave();
  }

  clearCaptions() {
    if (this.state.captions.length) {
      this.pushUndoSnapshot();
    }
    this.state.captions = [];
    this.state.selectedCaptionId = null;
    this.state.editingCaptionId = null;
    this.updateCueActionButtons();
    this.refs.cueInstantShow.checked = false;
    this.refs.cueTextOnly.checked = false;
    this.updateCueModeUi();
    this.refreshCaptionList();
    this.renderer.drawPreviewFrame();
    this.scheduleLocalSave();
  }

  async handleVideoFileSelected() {
    const [file] = this.refs.videoInput.files || [];
    if (!file) {
      return;
    }

    if (this.state.sourceObjectUrl) {
      URL.revokeObjectURL(this.state.sourceObjectUrl);
      this.state.sourceObjectUrl = null;
    }

    this.state.currentFileName = sanitizeFileName(file.name) || "caption_track";
    this.state.sourceObjectUrl = URL.createObjectURL(file);

    const metadataLoaded = new Promise((resolve, reject) => {
      const onLoaded = () => {
        this.refs.sourceVideo.removeEventListener("loadedmetadata", onLoaded);
        this.refs.sourceVideo.removeEventListener("error", onError);
        resolve();
      };

      const onError = () => {
        this.refs.sourceVideo.removeEventListener("loadedmetadata", onLoaded);
        this.refs.sourceVideo.removeEventListener("error", onError);
        reject(new Error("Unable to load video metadata."));
      };

      this.refs.sourceVideo.addEventListener("loadedmetadata", onLoaded);
      this.refs.sourceVideo.addEventListener("error", onError);
    });

    this.refs.sourceVideo.src = this.state.sourceObjectUrl;
    this.refs.sourceVideo.load();

    await metadataLoaded;
    await this.ensureFirstFrameReady();

    this.syncOutputCanvasSize();

    this.refs.seekBar.min = "0";
    this.refs.seekBar.max = String(this.refs.sourceVideo.duration);
    this.refs.seekBar.value = "0";
    this.refs.fullscreenSeekBar.min = "0";
    this.refs.fullscreenSeekBar.max = String(this.refs.sourceVideo.duration);
    this.refs.fullscreenSeekBar.value = "0";

    this.refs.captionStart.value = "0";
    this.refs.captionEnd.value = String(clamp(2, 0.1, this.refs.sourceVideo.duration));
    this.refs.captionMode.value = "dialogue";
    this.refs.cueInstantShow.checked = false;
    this.refs.cueTextOnly.checked = false;
    this.updateCueModeUi();
    this.syncFormEndWithStart();
    this.state.selectedCaptionId = null;
    this.state.editingCaptionId = null;
    this.updateCueActionButtons();

    this.refs.videoMeta.textContent = `${file.name} | source ${this.refs.sourceVideo.videoWidth}x${this.refs.sourceVideo.videoHeight}`;
    this.refs.durationLabel.textContent = `Duration: ${formatTime(this.refs.sourceVideo.duration)}`;
    this.refs.sourceVideo.muted = this.refs.muteSourcePreview.checked;
    this.updateMuteButtonState();
    this.state.loopRegion = this.resolveLoopRegion(this.refs.sourceVideo.currentTime || 0);

    await this.seekVideo(Math.min(0.033, this.refs.sourceVideo.duration || 0));
    this.updateCurrentTimeLabel();
    this.updateSeekBar();
    this.timeline.render();
    this.renderer.drawPreviewFrame();
    this.scheduleLocalSave();
  }

  handleTimelineCueChange({ id, start, end, final }) {
    if (this.state.isExporting) {
      return;
    }

    const caption = this.findCaptionById(id);
    if (!caption) {
      return;
    }

    if (!final && this.state.timelineUndoCueId !== id) {
      this.pushUndoSnapshot();
      this.state.timelineUndoCueId = id;
    }

    this.updateCaptionTimes(caption, start, end);

    if (final) {
      this.state.timelineUndoCueId = null;
      this.state.captions.sort((a, b) => a.start - b.start);
      this.refreshCaptionList();
      this.updateCurrentTimeLabel();
      this.updateSeekBar();
      this.scheduleLocalSave();

      if (this.state.loopPreviewEnabled) {
        void this.autoplayLoopRegion({ start: caption.start, end: caption.end });
      }
    }

    this.renderer.drawPreviewFrame();
  }

  async handleTimelineSeek(timeSeconds, options = {}) {
    if (this.state.isExporting) {
      return;
    }

    await this.seekPreviewTo(timeSeconds, options);
  }

  getSupportedMimeType(candidates) {
    for (const candidate of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    }

    return "";
  }

  getRecorderConfig(wantsAudio = false) {
    const container = this.refs.exportContainer.value === "mov" ? "mov" : "mp4";
    const commonWebm = wantsAudio
      ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm;codecs=opus", "video/webm"]
      : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

    if (container === "mp4") {
      const mp4Candidates = wantsAudio
        ? ["video/mp4;codecs=avc1.42E01E,mp4a.40.2"]
        : ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1.42E01E", "video/mp4"];
      const mp4Mime = this.getSupportedMimeType(mp4Candidates);
      if (mp4Mime) {
        return { mimeType: mp4Mime, extension: "mp4", fallbackUsed: false };
      }
    }

    if (container === "mov") {
      const movCandidates = wantsAudio
        ? ["video/quicktime;codecs=h264,aac", "video/mp4;codecs=avc1.42E01E,mp4a.40.2"]
        : ["video/quicktime;codecs=h264,aac", "video/quicktime", "video/mp4"];
      const movMime = this.getSupportedMimeType(movCandidates);
      if (movMime) {
        const extension = movMime.startsWith("video/quicktime") ? "mov" : "mp4";
        return { mimeType: movMime, extension, fallbackUsed: false };
      }
    }

    const webmMime = this.getSupportedMimeType(commonWebm);
    return { mimeType: webmMime, extension: "webm", fallbackUsed: true };
  }

  autoDownloadRenderOutput(objectUrl, fileName, runId) {
    if (!objectUrl || !fileName) {
      return;
    }

    if (!Number.isFinite(runId) || this.state.lastAutoDownloadedRunId === runId) {
      return;
    }

    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    this.state.lastAutoDownloadedRunId = runId;
  }

  // Render/export pipeline driven by MediaRecorder.
  requestExportCancel() {
    if (!this.state.isExporting) {
      return;
    }

    this.state.cancelExportRequested = true;
    this.setStatus("Stopping render...");
    this.refs.sourceVideo.pause();

    if (typeof this.state.cancelExportResolve === "function") {
      this.state.cancelExportResolve();
      this.state.cancelExportResolve = null;
    }

    if (this.state.exportRecorder && this.state.exportRecorder.state !== "inactive") {
      this.state.exportRecorder.stop();
    }
  }

  async collectSourceAudioTracksForExport() {
    if (!this.refs.sourceVideo.captureStream) {
      return { tracks: [], source: "unsupported" };
    }

    let sourceStream = null;
    try {
      sourceStream = this.refs.sourceVideo.captureStream();
    } catch (error) {
      console.warn("Unable to capture source media stream:", error);
      return { tracks: [], source: "capture-error" };
    }

    const getLiveTracks = () => sourceStream.getAudioTracks().filter((track) => track.readyState === "live");
    let audioTracks = getLiveTracks();
    if (audioTracks.length) {
      return { tracks: audioTracks, source: "capture" };
    }

    // Some browsers expose audio tracks on captureStream only after playback advances.
    try {
      await this.refs.sourceVideo.play();
      await new Promise((resolve) => {
        const timeoutId = window.setTimeout(resolve, 180);
        const onTimeUpdate = () => {
          window.clearTimeout(timeoutId);
          this.refs.sourceVideo.removeEventListener("timeupdate", onTimeUpdate);
          resolve();
        };
        this.refs.sourceVideo.addEventListener("timeupdate", onTimeUpdate, { once: true });
      });
    } catch (error) {
      console.warn("Audio priming playback failed:", error);
    } finally {
      this.refs.sourceVideo.pause();
      await this.seekVideo(0);
    }

    audioTracks = getLiveTracks();
    if (audioTracks.length) {
      return { tracks: audioTracks, source: "capture-primed" };
    }

    const webAudioTracks = await this.collectWebAudioTracksForExport();
    if (webAudioTracks.length) {
      return { tracks: webAudioTracks, source: "webaudio-fallback" };
    }

    return { tracks: [], source: "none" };
  }

  getAudioContextCtor() {
    if (typeof window === "undefined") {
      return null;
    }
    return window.AudioContext || window.webkitAudioContext || null;
  }

  async collectWebAudioTracksForExport() {
    const AudioContextCtor = this.getAudioContextCtor();
    if (!AudioContextCtor) {
      return [];
    }

    if (!this.state.exportAudioContext) {
      this.state.exportAudioContext = new AudioContextCtor();
    }

    const audioContext = this.state.exportAudioContext;
    if (audioContext.state === "suspended") {
      try {
        await audioContext.resume();
      } catch (error) {
        console.warn("Unable to resume export audio context:", error);
      }
    }

    if (!this.state.exportAudioSourceNode) {
      try {
        this.state.exportAudioSourceNode = audioContext.createMediaElementSource(this.refs.sourceVideo);
      } catch (error) {
        console.warn("Unable to create media element source for export audio:", error);
        return [];
      }
    }

    if (!this.state.exportAudioDestinationNode) {
      this.state.exportAudioDestinationNode = audioContext.createMediaStreamDestination();
      this.state.exportAudioSourceNode.connect(this.state.exportAudioDestinationNode);
    }

    return this.state.exportAudioDestinationNode.stream.getAudioTracks().filter((track) => track.readyState === "live");
  }

  async exportVideo() {
    if (this.state.isExporting) {
      return;
    }

    if (!this.refs.sourceVideo.videoWidth || !this.refs.sourceVideo.videoHeight || !this.getVideoDuration()) {
      window.alert("Load a source video before exporting.");
      return;
    }

    if (!this.state.captions.length) {
      window.alert("Add at least one dialogue cue before exporting.");
      return;
    }

    this.state.isExporting = true;
    this.state.cancelExportRequested = false;
    this.state.cancelExportResolve = null;
    const renderRunId = this.state.exportRunId + 1;
    this.state.exportRunId = renderRunId;
    this.refs.renderBtn.disabled = false;
    this.refs.renderBtn.textContent = "Stop Render";
    this.refs.downloadLink.hidden = true;
    this.refs.downloadLink.href = "#";
    this.refs.downloadLink.download = "";
    this.refs.downloadLink.textContent = "Download rendered video";
    this.setStatus("Preparing render...");

    const wasPaused = this.refs.sourceVideo.paused;
    const restoreTime = this.refs.sourceVideo.currentTime || 0;
    const previousMutedState = this.refs.sourceVideo.muted;

    this.refs.sourceVideo.pause();
    await this.seekVideo(0);

    this.syncOutputCanvasSize();
    this.updateCurrentTimeLabel();
    this.updateSeekBar();

    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = this.state.outputWidth;
    outputCanvas.height = this.state.outputHeight;
    const outputCtx = outputCanvas.getContext("2d", { alpha: false });
    const previewCtx = this.refs.previewCanvas.getContext("2d", { alpha: false });

    const fps = clamp(Math.round(parseNumber(this.refs.exportFps.value, 30)), 12, 60);
    const stream = outputCanvas.captureStream(fps);

    const wantsAudio = this.refs.includeAudio.checked && this.refs.outputMode.value === "composite";
    let includedAudioTracks = 0;
    let audioSource = "off";
    if (wantsAudio) {
      const audioResult = await this.collectSourceAudioTracksForExport();
      audioSource = audioResult.source;
      includedAudioTracks = audioResult.tracks.length;
      for (const track of audioResult.tracks) {
        stream.addTrack(track);
      }
    }

    const recorderConfig = this.getRecorderConfig(wantsAudio && includedAudioTracks > 0);
    const mimeType = recorderConfig.mimeType;
    const requestedExtension = this.refs.exportContainer.value === "mov" ? "mov" : "mp4";
    const formatSummary = `Format: requested .${requestedExtension} -> .${recorderConfig.extension}${mimeType ? ` (${mimeType})` : ""}${recorderConfig.fallbackUsed ? " [fallback]" : ""}`;
    const audioSummary =
      wantsAudio && includedAudioTracks > 0
        ? `Audio: included (${includedAudioTracks} track${includedAudioTracks === 1 ? "" : "s"})`
        : wantsAudio
          ? `Audio: no source track detected (${audioSource})`
          : "Audio: off";
    this.setStatus(`Preparing render... | ${formatSummary} | ${audioSummary}`);
    const recorderOptions = { videoBitsPerSecond: 8_000_000 };
    if (wantsAudio && includedAudioTracks > 0) {
      recorderOptions.audioBitsPerSecond = 160_000;
    }
    if (mimeType) {
      recorderOptions.mimeType = mimeType;
    }

    const recorder = new MediaRecorder(stream, recorderOptions);
    this.state.exportRecorder = recorder;
    const chunks = [];

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    });

    const stopped = new Promise((resolve) => {
      recorder.addEventListener("stop", resolve, { once: true });
    });

    const cancelled = new Promise((resolve) => {
      this.state.cancelExportResolve = resolve;
    });

    this.refs.sourceVideo.muted = !wantsAudio;

    const syncPreviewDuringExport = () => {
      this.updateCurrentTimeLabel();
      this.updateSeekBar();

      if (!previewCtx) {
        return;
      }

      if (this.refs.outputMode.value === "composite") {
        previewCtx.imageSmoothingEnabled = false;
        previewCtx.drawImage(outputCanvas, 0, 0, previewCtx.canvas.width, previewCtx.canvas.height);
      } else {
        // Keep preview readable (non-green) while rendering overlay exports.
        this.renderer.drawPreviewFrame();
      }
    };

    this.renderer.renderFrame(outputCtx, 0, this.refs.outputMode.value);
    syncPreviewDuringExport();
    recorder.start(100);
    let lastStatusUpdate = 0;
    const statusUpdateIntervalMs = 220;

    const renderLoop = () => {
      this.renderer.renderFrame(outputCtx, this.refs.sourceVideo.currentTime || 0, this.refs.outputMode.value);
      syncPreviewDuringExport();

      const duration = this.refs.sourceVideo.duration;
      const percent = duration ? Math.min(100, ((this.refs.sourceVideo.currentTime || 0) / duration) * 100) : 0;
      const now = performance.now();
      if (now - lastStatusUpdate >= statusUpdateIntervalMs || percent >= 99.9) {
        this.setStatus(`Rendering... ${percent.toFixed(1)}% | ${formatSummary} | ${audioSummary}`);
        lastStatusUpdate = now;
      }

      if (!this.refs.sourceVideo.paused && !this.refs.sourceVideo.ended) {
        this.state.exportRaf = requestAnimationFrame(renderLoop);
      }
    };

    const ended = new Promise((resolve) => {
      this.refs.sourceVideo.addEventListener("ended", resolve, { once: true });
    });

    try {
      await this.refs.sourceVideo.play();
      renderLoop();
      await Promise.race([ended, cancelled]);
    } catch (error) {
      console.error(error);
      window.alert("The browser blocked playback during export. Click play once and retry.");
    } finally {
      cancelAnimationFrame(this.state.exportRaf);
      this.state.cancelExportResolve = null;

      if (!this.state.cancelExportRequested) {
        this.renderer.renderFrame(outputCtx, this.refs.sourceVideo.duration, this.refs.outputMode.value);
      }

      if (recorder.state !== "inactive") {
        recorder.stop();
      }

      await stopped;

      if (!this.state.cancelExportRequested) {
        if (this.state.renderObjectUrl) {
          URL.revokeObjectURL(this.state.renderObjectUrl);
          this.state.renderObjectUrl = null;
        }

        const blob = new Blob(chunks, { type: mimeType || "video/webm" });
        if (blob.size <= 0) {
          this.refs.downloadLink.hidden = true;
          this.setStatus(`Render failed (empty output). | ${formatSummary} | ${audioSummary}`);
        } else {
          this.state.renderObjectUrl = URL.createObjectURL(blob);

          const outputFileName = `${this.state.currentFileName}_captions.${recorderConfig.extension}`;
          this.refs.downloadLink.href = this.state.renderObjectUrl;
          this.refs.downloadLink.download = outputFileName;
          this.refs.downloadLink.textContent = `Download rendered video (.${recorderConfig.extension}${mimeType ? `, ${mimeType}` : ""})`;
          this.refs.downloadLink.hidden = false;
          this.autoDownloadRenderOutput(this.state.renderObjectUrl, outputFileName, renderRunId);

          this.setStatus(`Done. ${Math.round(blob.size / 1024 / 1024)} MB output ready. | ${formatSummary} | ${audioSummary}`);
        }
      } else {
        this.setStatus(`Render cancelled. | ${formatSummary} | ${audioSummary}`);
      }

      this.refs.sourceVideo.pause();
      await this.seekVideo(restoreTime);
      this.refs.sourceVideo.muted = previousMutedState || this.refs.muteSourcePreview.checked;

      if (!wasPaused && !this.state.cancelExportRequested) {
        await this.refs.sourceVideo.play().catch(() => {
          /* ignore autoplay errors */
        });
      }

      this.state.exportRecorder = null;
      this.state.isExporting = false;
      this.state.cancelExportRequested = false;
      this.refs.renderBtn.textContent = "Render Caption Video";
      this.refs.renderBtn.disabled = false;
      if (!this.refs.sourceVideo.paused && !this.refs.sourceVideo.ended) {
        this.refs.playPauseBtn.textContent = "Pause";
        this.startPreviewLoop();
      } else {
        this.updateCurrentTimeLabel();
        this.updateSeekBar();
        this.renderer.drawPreviewFrame();
      }
    }
  }

  startPreviewLoop() {
    if (this.state.isExporting) {
      return;
    }

    cancelAnimationFrame(this.state.previewRaf);

    const tick = () => {
      this.updateCurrentTimeLabel();
      this.updateSeekBar();
      this.renderer.drawPreviewFrame();

      if (!this.refs.sourceVideo.paused && !this.refs.sourceVideo.ended) {
        this.state.previewRaf = requestAnimationFrame(tick);
      }
    };

    tick();
  }

  stopPreviewLoop() {
    cancelAnimationFrame(this.state.previewRaf);
    if (this.state.isExporting) {
      return;
    }

    this.renderer.drawPreviewFrame();
    this.updateCurrentTimeLabel();
    this.updateSeekBar();
  }

  focusCueForEditing(caption) {
    if (!caption) {
      this.renderer.drawPreviewFrame();
      return;
    }

    const duration = this.getVideoDuration();
    if (!duration) {
      this.renderer.drawPreviewFrame();
      return;
    }

    const currentTime = this.refs.sourceVideo.currentTime || 0;
    const outsideCue = currentTime < caption.start - 0.01 || currentTime > caption.end + 0.01;
    if (outsideCue) {
      void this.seekPreviewTo(caption.start, { scrubbing: true });
      return;
    }

    this.renderer.drawPreviewFrame();
  }

  getPlatformSafePercentBounds() {
    if (!this.refs.usePlatformSafeArea?.checked) {
      return null;
    }

    const minX = PLATFORM_SAFE_INSETS.left * 100;
    const maxX = 100 - PLATFORM_SAFE_INSETS.right * 100;
    const minY = PLATFORM_SAFE_INSETS.top * 100;
    const maxY = 100 - PLATFORM_SAFE_INSETS.bottom * 100;
    if (maxX <= minX || maxY <= minY) {
      return null;
    }

    return {
      minX,
      maxX,
      minY,
      maxY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  // Preview drag interactions (dramatic cue edits + global dialogue override).
  isDialogueManualPositionEnabled(cueMode) {
    return (cueMode === "dialogue" || cueMode === "choice") && !!this.refs.manualDialoguePosition?.checked;
  }

  toPreviewClientLayout(layout, rect) {
    const canvasWidth = Math.max(1, this.refs.previewCanvas.width || 1);
    const canvasHeight = Math.max(1, this.refs.previewCanvas.height || 1);
    const scaleX = rect.width / canvasWidth;
    const scaleY = rect.height / canvasHeight;

    return {
      x: layout.x * scaleX,
      y: layout.y * scaleY,
      width: layout.width * scaleX,
      height: layout.height * scaleY,
      handleSize: Math.max(8, (layout.handleSize || 12) * Math.min(scaleX, scaleY))
    };
  }

  startPreviewCueDrag(event) {
    if (this.state.isExporting) {
      return;
    }

    if (document.fullscreenElement === this.refs.previewPanel) {
      return;
    }

    const layout = this.renderer.getInteractiveCueLayout();
    if (!layout) {
      if (this.state.editingCaptionId) {
        const editingCaption = this.findCaptionById(this.state.editingCaptionId);
        if (editingCaption) {
          this.state.selectedCaptionId = editingCaption.id;
          this.focusCueForEditing(editingCaption);
        }
      }
      return;
    }

    const caption = this.findCaptionById(layout.id);
    if (!caption) {
      return;
    }

    const cueMode = this.normalizeCueMode(caption.mode);
    const dialogueManualEnabled = this.isDialogueManualPositionEnabled(cueMode);
    const dramaticEditable =
      cueMode === "dramatic" && !!this.state.editingCaptionId && this.state.editingCaptionId === caption.id;
    if (!dialogueManualEnabled && !dramaticEditable) {
      return;
    }

    if (cueMode === "dramatic" && this.state.selectedCaptionId !== caption.id) {
      this.selectCaption(caption.id, { syncForm: true });
      this.renderer.drawPreviewFrame();
    }

    const rect = this.refs.previewCanvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const clientLayout = this.toPreviewClientLayout(layout, rect);

    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const withinCue =
      pointerX >= clientLayout.x &&
      pointerX <= clientLayout.x + clientLayout.width &&
      pointerY >= clientLayout.y &&
      pointerY <= clientLayout.y + clientLayout.height;
    if (!withinCue) {
      return;
    }

    let isResize = false;
    if (cueMode === "dramatic") {
      const handleSize = clientLayout.handleSize || 12;
      const handleLeft = clientLayout.x + clientLayout.width - handleSize;
      const handleTop = clientLayout.y + clientLayout.height - handleSize;
      isResize = pointerX >= handleLeft && pointerY >= handleTop;
    }

    this.pushUndoSnapshot();
    event.preventDefault();

    const canvasWidth = Math.max(1, this.refs.previewCanvas.width);
    const canvasHeight = Math.max(1, this.refs.previewCanvas.height);
    const startXPercent = (layout.x / canvasWidth) * 100;
    const startYPercent = (layout.y / canvasHeight) * 100;
    const startWidthPercent = (layout.width / canvasWidth) * 100;
    const startHeightPercent = (layout.height / canvasHeight) * 100;

    if (cueMode === "dramatic" && isResize) {
      // Lock current visual position before size changes so resize doesn't re-anchor unexpectedly.
      if (!Number.isFinite(caption.positionX)) {
        caption.positionX = roundToHundredths(clamp(startXPercent, 0, 100));
      }
      if (!Number.isFinite(caption.positionY)) {
        caption.positionY = roundToHundredths(clamp(startYPercent, 0, 100));
      }
    } else if (dialogueManualEnabled) {
      if (!Number.isFinite(this.state.dialoguePositionX)) {
        this.state.dialoguePositionX = roundToHundredths(clamp(startXPercent, 0, 100));
      }
      if (!Number.isFinite(this.state.dialoguePositionY)) {
        this.state.dialoguePositionY = roundToHundredths(clamp(startYPercent, 0, 100));
      }
    }

    this.state.previewDrag = {
      pointerId: event.pointerId,
      cueId: cueMode === "dramatic" ? caption.id : null,
      target: cueMode === "dramatic" ? "cue" : "dialogue",
      mode: isResize ? "resize" : "move",
      startClientX: event.clientX,
      startClientY: event.clientY,
      startXPercent,
      startYPercent,
      startWidthPercent,
      startHeightPercent,
      moved: false
    };

    this.refs.previewCanvas.setPointerCapture(event.pointerId);
  }

  handlePreviewCueDragMove(event) {
    const drag = this.state.previewDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      this.updatePreviewCanvasCursor(event);
      return;
    }

    const caption = drag.target === "cue" ? this.findCaptionById(drag.cueId) : null;
    if (drag.target === "cue" && !caption) {
      return;
    }

    const rect = this.refs.previewCanvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const deltaXPercent = ((event.clientX - drag.startClientX) / rect.width) * 100;
    const deltaYPercent = ((event.clientY - drag.startClientY) / rect.height) * 100;
    const safeBounds = this.getPlatformSafePercentBounds();

    if (drag.target === "cue" && drag.mode === "resize") {
      const anchorX = safeBounds ? clamp(drag.startXPercent, safeBounds.minX, safeBounds.maxX) : clamp(drag.startXPercent, 0, 100);
      const anchorY = safeBounds ? clamp(drag.startYPercent, safeBounds.minY, safeBounds.maxY) : clamp(drag.startYPercent, 0, 100);
      const maxWidthForPosition = safeBounds ? Math.max(6, safeBounds.maxX - anchorX) : Math.max(20, 100 - anchorX);
      const maxHeightForPosition = safeBounds ? Math.max(6, safeBounds.maxY - anchorY) : Math.max(6, 100 - anchorY);
      const minWidth = Math.min(20, maxWidthForPosition);
      const minHeight = Math.min(6, maxHeightForPosition);
      const nextWidth = clamp(drag.startWidthPercent + deltaXPercent, minWidth, Math.min(95, maxWidthForPosition));
      const nextHeight = clamp(drag.startHeightPercent + deltaYPercent, minHeight, Math.min(80, maxHeightForPosition));
      caption.boxWidthPercent = roundToHundredths(nextWidth);
      caption.boxHeightPercent = roundToHundredths(nextHeight);
    } else if (drag.target === "cue") {
      const widthPercent = clamp(drag.startWidthPercent, 0.5, 100);
      const heightPercent = clamp(drag.startHeightPercent, 0.5, 100);
      const minX = safeBounds ? safeBounds.minX : 0;
      const minY = safeBounds ? safeBounds.minY : 0;
      const maxX = safeBounds ? Math.max(minX, safeBounds.maxX - widthPercent) : Math.max(0, 100 - widthPercent);
      const maxY = safeBounds ? Math.max(minY, safeBounds.maxY - heightPercent) : Math.max(0, 100 - heightPercent);
      const nextX = clamp(drag.startXPercent + deltaXPercent, minX, maxX);
      const nextY = clamp(drag.startYPercent + deltaYPercent, minY, maxY);
      caption.positionX = roundToHundredths(nextX);
      caption.positionY = roundToHundredths(nextY);
    } else {
      const widthPercent = clamp(drag.startWidthPercent, 0.5, 100);
      const heightPercent = clamp(drag.startHeightPercent, 0.5, 100);
      const minX = safeBounds ? safeBounds.minX : 0;
      const minY = safeBounds ? safeBounds.minY : 0;
      const maxX = safeBounds ? Math.max(minX, safeBounds.maxX - widthPercent) : Math.max(0, 100 - widthPercent);
      const maxY = safeBounds ? Math.max(minY, safeBounds.maxY - heightPercent) : Math.max(0, 100 - heightPercent);
      const nextX = clamp(drag.startXPercent + deltaXPercent, minX, maxX);
      const nextY = clamp(drag.startYPercent + deltaYPercent, minY, maxY);
      this.state.dialoguePositionX = roundToHundredths(nextX);
      this.state.dialoguePositionY = roundToHundredths(nextY);
    }

    drag.moved = true;
    this.renderer.drawPreviewFrame();
    this.updatePreviewCanvasCursor(event);
  }

  finalizePreviewCueDrag(event) {
    const drag = this.state.previewDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    this.state.previewDrag = null;
    if (this.refs.previewCanvas.hasPointerCapture(event.pointerId)) {
      this.refs.previewCanvas.releasePointerCapture(event.pointerId);
    }

    if (drag.moved) {
      if (drag.target === "cue") {
        this.refreshCaptionList();
      }
      this.scheduleLocalSave();
    } else {
      if (this.state.undoStack.length) {
        this.state.undoStack.pop();
      }
    }
    this.refs.previewCanvas.style.cursor = "default";
  }

  updatePreviewCanvasCursor(event) {
    const drag = this.state.previewDrag;
    if (drag) {
      this.refs.previewCanvas.style.cursor = drag.mode === "resize" ? "nwse-resize" : "move";
      return;
    }

    if (document.fullscreenElement === this.refs.previewPanel) {
      this.refs.previewCanvas.style.cursor = "default";
      return;
    }

    const layout = this.renderer.getInteractiveCueLayout();
    if (!layout) {
      this.refs.previewCanvas.style.cursor = "default";
      return;
    }

    const cursorCaption = this.findCaptionById(layout.id);
    if (!cursorCaption) {
      this.refs.previewCanvas.style.cursor = "default";
      return;
    }

    const cueMode = this.normalizeCueMode(cursorCaption.mode);
    const dialogueManualEnabled = this.isDialogueManualPositionEnabled(cueMode);
    const dramaticEditable =
      cueMode === "dramatic" &&
      layout.id === this.state.selectedCaptionId &&
      !!this.state.editingCaptionId &&
      this.state.editingCaptionId === layout.id;
    if (!dialogueManualEnabled && !dramaticEditable) {
      this.refs.previewCanvas.style.cursor = "default";
      return;
    }

    const rect = this.refs.previewCanvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      this.refs.previewCanvas.style.cursor = "default";
      return;
    }
    const clientLayout = this.toPreviewClientLayout(layout, rect);

    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const withinCue =
      pointerX >= clientLayout.x &&
      pointerX <= clientLayout.x + clientLayout.width &&
      pointerY >= clientLayout.y &&
      pointerY <= clientLayout.y + clientLayout.height;
    if (!withinCue) {
      this.refs.previewCanvas.style.cursor = "default";
      return;
    }

    const handleSize = clientLayout.handleSize || 12;
    const handleLeft = clientLayout.x + clientLayout.width - handleSize;
    const handleTop = clientLayout.y + clientLayout.height - handleSize;
    const resizeHit = dramaticEditable && pointerX >= handleLeft && pointerY >= handleTop;
    this.refs.previewCanvas.style.cursor = resizeHit ? "nwse-resize" : "move";
  }

  bindEvents() {
    const triggerVideoPicker = () => {
      this.refs.videoInput.click();
    };

    this.refs.chooseVideoBtn?.addEventListener("click", triggerVideoPicker);
    this.refs.openVideoPickerBtn.addEventListener("click", triggerVideoPicker);

    this.refs.videoInput.addEventListener("change", () => {
      this.handleVideoFileSelected().catch((error) => {
        console.error(error);
        window.alert("Could not load that video file.");
      });
    });

    this.refs.addCaptionBtn.addEventListener("click", () => this.addCaption());
    this.refs.cancelEditBtn.addEventListener("click", () => {
      this.clearCueEditMode({ refresh: true, redraw: true, save: true });
    });
    this.refs.clearCaptionsBtn.addEventListener("click", () => this.clearCaptions());
    this.refs.exportCuesBtn.addEventListener("click", () => this.exportCuesToFile());
    this.refs.importCuesBtn.addEventListener("click", () => {
      this.refs.importCuesInput.click();
    });
    this.refs.importCuesInput.addEventListener("change", () => {
      const [file] = this.refs.importCuesInput.files || [];
      this.importCuesFromFile(file).catch((error) => {
        console.error(error);
        window.alert("Could not import cue JSON.");
      }).finally(() => {
        this.refs.importCuesInput.value = "";
      });
    });
    this.refs.captionMode.addEventListener("change", () => {
      this.updateCueModeUi();
      this.scheduleLocalSave();
    });

    this.refs.captionStart.addEventListener("input", () => {
      this.syncFormEndWithStart();
      this.scheduleLocalSave();
    });

    this.refs.setStartBtn.addEventListener("click", () => {
      this.refs.captionStart.value = (this.refs.sourceVideo.currentTime || 0).toFixed(2);
      this.syncFormEndWithStart();
      this.scheduleLocalSave();
    });

    this.refs.setEndBtn.addEventListener("click", () => {
      this.refs.captionEnd.value = (this.refs.sourceVideo.currentTime || 0).toFixed(2);
      this.scheduleLocalSave();
    });

    this.refs.playPauseBtn.addEventListener("click", async () => {
      if (this.state.isExporting) {
        this.setStatus("Rendering in progress. Use Stop Render to cancel.");
        return;
      }

      if (!this.getVideoDuration()) {
        return;
      }

      if (this.refs.sourceVideo.paused || this.refs.sourceVideo.ended) {
        if (this.refs.sourceVideo.ended) {
          await this.seekVideo(0);
        }
        await this.refs.sourceVideo.play().catch(() => {
          /* ignore autoplay errors */
        });
      } else {
        this.refs.sourceVideo.pause();
      }
    });

    this.refs.muteToggleBtn.addEventListener("click", () => {
      this.toggleMute();
    });

    this.refs.loopToggleBtn.addEventListener("click", () => {
      this.toggleLoopPreview();
    });

    this.refs.fullscreenCornerBtn.addEventListener("click", async () => {
      await this.toggleFullscreenPreview();
    });

    this.refs.fullscreenExitBtn.addEventListener("click", async () => {
      if (document.fullscreenElement === this.refs.previewPanel) {
        await document.exitFullscreen().catch(() => {
          /* ignore */
        });
      }
    });

    this.refs.previewCanvas.addEventListener("pointerdown", (event) => {
      this.startPreviewCueDrag(event);
    });
    this.refs.previewCanvas.addEventListener("pointermove", (event) => {
      this.handlePreviewCueDragMove(event);
    });
    this.refs.previewCanvas.addEventListener("pointerup", (event) => {
      this.finalizePreviewCueDrag(event);
    });
    this.refs.previewCanvas.addEventListener("pointercancel", (event) => {
      this.finalizePreviewCueDrag(event);
    });
    this.refs.previewCanvas.addEventListener("pointerleave", () => {
      if (!this.state.previewDrag) {
        this.refs.previewCanvas.style.cursor = "default";
      }
    });

    document.addEventListener("fullscreenchange", () => {
      this.updateFullscreenUiState();
    });

    const bindSeekInput = (inputEl) => {
      inputEl.addEventListener("input", async (event) => {
        if (this.state.isExporting) {
          return;
        }

        if (!this.getVideoDuration()) {
          return;
        }
        const target = parseNumber(event.target.value, 0);
        await this.seekPreviewTo(target, { scrubbing: false });
      });
    };

    bindSeekInput(this.refs.seekBar);
    bindSeekInput(this.refs.fullscreenSeekBar);

    this.refs.sourceVideo.addEventListener("play", () => {
      this.refs.playPauseBtn.textContent = this.state.isExporting ? "Play" : "Pause";
      this.startPreviewLoop();
    });

    this.refs.sourceVideo.addEventListener("pause", () => {
      this.refs.playPauseBtn.textContent = "Play";
      this.stopPreviewLoop();
    });

    this.refs.sourceVideo.addEventListener("ended", () => {
      this.refs.playPauseBtn.textContent = "Play";
      this.stopPreviewLoop();
    });

    this.refs.sourceVideo.addEventListener("timeupdate", () => {
      this.applyLoopGuard();
    });

    this.refs.muteSourcePreview.addEventListener("change", () => {
      if (!this.state.isExporting) {
        this.refs.sourceVideo.muted = this.refs.muteSourcePreview.checked;
      }
      this.updateMuteButtonState();
      this.scheduleLocalSave();
    });

    this.refs.captionText.addEventListener("input", () => {
      this.scheduleLocalSave();
    });

    this.refs.captionEnd.addEventListener("input", () => {
      this.scheduleLocalSave();
    });

    this.refs.cueInstantShow.addEventListener("change", () => {
      this.scheduleLocalSave();
    });

    this.refs.cueTextOnly.addEventListener("change", () => {
      this.scheduleLocalSave();
    });

    const rerenderInputs = document.querySelectorAll("[data-rerender='true']");
    for (const input of rerenderInputs) {
      input.addEventListener("input", () => {
        if (input === this.refs.formatPreset) {
          this.syncOutputCanvasSize();
        }

        this.updatePixelScaleLabel();
        this.updateTextPixelationLabel();
        this.renderer.drawPreviewFrame();
        this.scheduleLocalSave();
      });

      input.addEventListener("change", () => {
        if (input === this.refs.formatPreset) {
          this.syncOutputCanvasSize();
        }

        this.updatePixelScaleLabel();
        this.updateTextPixelationLabel();
        this.renderer.drawPreviewFrame();
        this.scheduleLocalSave();
      });
    }

    this.refs.renderBtn.addEventListener("click", () => {
      if (this.state.isExporting) {
        this.requestExportCancel();
        return;
      }

      this.exportVideo().catch((error) => {
        console.error(error);
        this.setStatus("Render failed. Check console for details.");
        this.refs.renderBtn.textContent = "Render Caption Video";
        this.refs.renderBtn.disabled = false;
        this.state.isExporting = false;
        this.state.cancelExportRequested = false;
        this.state.cancelExportResolve = null;
        this.state.exportRecorder = null;
      });
    });

    document.addEventListener("keydown", async (event) => {
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ") {
        event.preventDefault();
        this.undoLastAction();
        return;
      }

      if (event.code === "KeyU") {
        event.preventDefault();
        this.undoLastAction();
      } else if (event.code === "Space") {
        if (this.state.isExporting) {
          event.preventDefault();
          this.setStatus("Rendering in progress. Use Stop Render to cancel.");
          return;
        }

        if (!this.getVideoDuration()) {
          return;
        }
        event.preventDefault();

        if (this.refs.sourceVideo.paused || this.refs.sourceVideo.ended) {
          if (this.refs.sourceVideo.ended) {
            await this.seekVideo(0);
          }
          await this.refs.sourceVideo.play().catch(() => {
            /* ignore autoplay errors */
          });
        } else {
          this.refs.sourceVideo.pause();
        }
      } else if (event.code === "KeyS") {
        event.preventDefault();
        await this.jumpToStart();
      } else if (event.code === "KeyM") {
        event.preventDefault();
        this.toggleMute();
      } else if (event.code === "KeyC") {
        event.preventDefault();
        this.addCueAtPlayhead();
      } else if (event.code === "KeyX") {
        event.preventDefault();
        this.deleteSelectedCaption();
      } else if (event.code === "KeyE") {
        event.preventDefault();
        this.toggleEditSelectedCaption();
      }
    });
  }
}

if (typeof document !== "undefined") {
  const app = new CaptionMakerApp();
  app.init();
}
