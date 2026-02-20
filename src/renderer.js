import { clamp } from "./utils.js";

const PLATFORM_SAFE_INSETS = Object.freeze({
  left: 65 / 1080,
  right: 192 / 1080,
  top: 240 / 1920,
  bottom: 520 / 1920
});

export class CaptionRenderer {
  constructor({ video, previewCanvas, getStyle, getCaptions, getSelectedCueId, getEditableCueId }) {
    this.video = video;
    this.previewCanvas = previewCanvas;
    this.getStyle = getStyle;
    this.getCaptions = getCaptions;
    this.getSelectedCueId = typeof getSelectedCueId === "function" ? getSelectedCueId : () => null;
    this.getEditableCueId = typeof getEditableCueId === "function" ? getEditableCueId : () => null;

    this.previewCtx = this.previewCanvas.getContext("2d", { alpha: false });
    this.captionLayer = document.createElement("canvas");
    this.captionCtx = this.captionLayer.getContext("2d", { alpha: true });
    this.textLayer = document.createElement("canvas");
    this.textCtx = this.textLayer.getContext("2d", { alpha: true });
    this.activeCueLayout = null;
    this.metricsCache = new Map();
    this.maxMetricsCacheEntries = 420;
  }

  setPreviewSize(width, height) {
    this.previewCanvas.width = width;
    this.previewCanvas.height = height;
  }

  drawPreviewFrame() {
    if (!this.video.videoWidth || !this.video.videoHeight) {
      this.previewCtx.fillStyle = "#0a121f";
      this.previewCtx.fillRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
      return;
    }

    this.renderFrame(this.previewCtx, this.video.currentTime || 0, "composite");
  }

  renderFrame(targetCtx, timeSeconds, mode) {
    const width = targetCtx.canvas.width;
    const height = targetCtx.canvas.height;
    const style = this.getStyle();

    targetCtx.imageSmoothingEnabled = false;

    if (mode === "composite") {
      this.drawSourceVideoCover(targetCtx, width, height);
    } else {
      targetCtx.fillStyle = style.chromaColor;
      targetCtx.fillRect(0, 0, width, height);
    }

    this.renderCaptionLayer(timeSeconds, style, width, height);
    targetCtx.drawImage(this.captionLayer, 0, 0, width, height);

    if (targetCtx === this.previewCtx) {
      this.drawSelectedCueOverlay(targetCtx);
    }
  }

  drawSourceVideoCover(targetCtx, width, height) {
    if (!this.video.videoWidth || !this.video.videoHeight) {
      targetCtx.fillStyle = "#0a121f";
      targetCtx.fillRect(0, 0, width, height);
      return;
    }

    const sourceWidth = this.video.videoWidth;
    const sourceHeight = this.video.videoHeight;
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    const drawX = (width - drawWidth) / 2;
    const drawY = (height - drawHeight) / 2;

    targetCtx.drawImage(this.video, drawX, drawY, drawWidth, drawHeight);
  }

  buildCacheKey(parts) {
    return JSON.stringify(parts);
  }

  getCachedMetrics(cacheKey, buildMetrics) {
    if (this.metricsCache.has(cacheKey)) {
      return this.metricsCache.get(cacheKey);
    }

    const metrics = buildMetrics();
    if (!this.metricsCache.has(cacheKey) && this.metricsCache.size >= this.maxMetricsCacheEntries) {
      const firstKey = this.metricsCache.keys().next().value;
      if (firstKey) {
        this.metricsCache.delete(firstKey);
      }
    }
    this.metricsCache.set(cacheKey, metrics);
    return metrics;
  }

  // Draw active cue into offscreen layer, then composite into output frame.
  renderCaptionLayer(timeSeconds, style, outputWidth, outputHeight) {
    const { layerWidth, layerHeight } = this.ensureCaptionLayerSize(outputWidth, outputHeight, style.pixelScale);
    this.captionCtx.clearRect(0, 0, layerWidth, layerHeight);
    this.activeCueLayout = null;

    const active = this.getActiveCaption(timeSeconds);
    if (!active) {
      return;
    }

    const cueMode = this.normalizeCueMode(active.mode);
    const instantShow = !!active.instantShow;
    const animatedText =
      cueMode === "choice" || instantShow
        ? active.text
        : this.buildAnimatedText(active, timeSeconds, style.animationStyle, style.animationDuration);

    const alpha = instantShow
      ? 1
      : this.computeAnimationAlpha(active, timeSeconds, style.animationStyle, style.animationDuration);

    if (cueMode === "dramatic") {
      const dramaticLayout = this.renderDramaticCaption(
        this.captionCtx,
        animatedText,
        style,
        layerWidth,
        layerHeight,
        alpha,
        !active.textOnly,
        active
      );
      this.setActiveCueLayout(active.id, cueMode, dramaticLayout, layerWidth, layerHeight, outputWidth, outputHeight);
      return;
    }

    const safeBounds = this.resolvePlatformSafeBounds(layerWidth, layerHeight, style);
    const boxWidthPercent = clamp(style.boxWidthPercent, 20, 95);
    const boxHeightPercent = 34;
    const blinkOn = Math.floor(timeSeconds * 2) % 2 === 0;
    const maxBoxWidth = safeBounds ? Math.max(8, safeBounds.width) : layerWidth;
    const maxBoxHeight = safeBounds ? Math.max(12, safeBounds.height) : layerHeight;
    const boxWidth = clamp(Math.floor(layerWidth * (boxWidthPercent / 100)), 8, maxBoxWidth);
    const targetBoxHeight = clamp(Math.floor(layerHeight * (boxHeightPercent / 100)), 12, maxBoxHeight);
    const hasFixedHeight = false;

    const measureBox = (candidateFontSize) => {
      const safeFontSize = clamp(Math.round(candidateFontSize), 6, 200);
      const boxPadding = Math.max(4, Math.floor(safeFontSize * 0.75));
      const boxLineHeight = safeFontSize + 4;
      const boxMaxTextWidth = Math.max(8, boxWidth - boxPadding * 2);
      this.captionCtx.font = `${safeFontSize}px "Press Start 2P", monospace`;
      const boxLines =
        cueMode === "choice"
          ? this.buildChoiceLines(this.captionCtx, active.text, boxMaxTextWidth, blinkOn)
          : this.wrapText(this.captionCtx, animatedText, boxMaxTextWidth);
      const boxNaturalHeight = boxLines.length * boxLineHeight + boxPadding * 2;
      return {
        fontSize: safeFontSize,
        padding: boxPadding,
        lineHeight: boxLineHeight,
        maxTextWidth: boxMaxTextWidth,
        lines: boxLines,
        naturalHeight: boxNaturalHeight,
        fitHeight: boxNaturalHeight
      };
    };

    const maxDialogueFont = Math.min(96, Math.max(6, Math.floor(targetBoxHeight * 0.9)));
    const dialogueCacheKey = this.buildCacheKey([
      "dialogue-metrics",
      active.id,
      cueMode,
      cueMode === "choice" ? active.text : animatedText,
      cueMode === "choice" ? (blinkOn ? 1 : 0) : 0,
      boxWidth,
      targetBoxHeight,
      style.fontSize
    ]);
    const metrics = this.getCachedMetrics(dialogueCacheKey, () => {
      return this.fitMetricsToHeight({
        measureFn: measureBox,
        minFont: 6,
        initialFont: style.fontSize,
        maxFont: maxDialogueFont,
        targetHeight: targetBoxHeight,
        allowGrow: hasFixedHeight
      });
    });

    const fontSize = metrics.fontSize;
    const padding = metrics.padding;
    const lineHeight = metrics.lineHeight;
    const lines = metrics.lines;
    const naturalBoxHeight = metrics.naturalHeight;
    const boxHeight = hasFixedHeight ? targetBoxHeight : naturalBoxHeight;
    const resolvedWidthPercent = clamp((boxWidth / Math.max(1, layerWidth)) * 100, 0.5, 95);
    const resolvedHeightPercent = clamp((boxHeight / Math.max(1, layerHeight)) * 100, 0.5, 80);

    const offsetPx = Math.floor(style.bottomOffset / style.pixelScale);
    const defaultX = Math.floor((layerWidth - boxWidth) / 2);
    const defaultY = Math.max(2, layerHeight - boxHeight - offsetPx);
    const dialoguePositionOverride =
      style.manualDialoguePosition &&
      Number.isFinite(style.dialoguePositionX) &&
      Number.isFinite(style.dialoguePositionY)
        ? { positionX: style.dialoguePositionX, positionY: style.dialoguePositionY }
        : null;
    const { x, y } = this.resolveCuePosition(
      dialoguePositionOverride,
      defaultX,
      defaultY,
      boxWidth,
      boxHeight,
      layerWidth,
      layerHeight,
      style
    );

    this.captionCtx.save();
    this.captionCtx.globalAlpha = alpha;

    this.drawDialogueWindow(this.captionCtx, x, y, boxWidth, boxHeight, style.boxStyle);

    const textX = x + padding;
    const textY = y + padding;
    const textScale = clamp(style.textPixelation, 0.5, 2.4);
    const textLayerWidth = Math.max(1, Math.floor((boxWidth - padding * 2) / textScale));
    const textLayerHeight = Math.max(1, Math.floor((boxHeight - padding * 2) / textScale));

    if (this.textLayer.width !== textLayerWidth || this.textLayer.height !== textLayerHeight) {
      this.textLayer.width = textLayerWidth;
      this.textLayer.height = textLayerHeight;
    }

    this.textCtx.clearRect(0, 0, textLayerWidth, textLayerHeight);
    this.textCtx.imageSmoothingEnabled = false;
    this.textCtx.textBaseline = "top";
    this.textCtx.textAlign = "left";
    this.textCtx.font = `${Math.max(7, fontSize / textScale)}px "Press Start 2P", monospace`;

    const textLineHeight = Math.max(7, lineHeight / textScale);
    const textColor = style.textColor || "#f8f8f8";

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const lineY = index * textLineHeight;
      this.textCtx.fillStyle = textColor;
      this.textCtx.fillText(line, 0, lineY);
    }

    const revealProgress = clamp((timeSeconds - active.start) / style.animationDuration, 0, 1);
    const shouldShowArrow =
      cueMode === "dialogue" &&
      (instantShow || (style.animationStyle === "typewriter" && revealProgress >= 1) || style.animationStyle === "none");

    if (shouldShowArrow && blinkOn) {
      let arrowWidth = Math.max(3, Math.round(7 / textScale));
      if (arrowWidth % 2 === 0) {
        arrowWidth += 1;
      }
      const arrowHeight = Math.floor((arrowWidth + 1) / 2);
      const arrowX = Math.max(0, textLayerWidth - arrowWidth - 1);
      const arrowY = Math.max(0, textLayerHeight - arrowHeight - 1);
      this.drawDownArrow(this.textCtx, arrowX, arrowY, "#ffffff", arrowWidth);
    }

    this.captionCtx.imageSmoothingEnabled = false;
    this.captionCtx.drawImage(this.textLayer, textX, textY, textLayerWidth * textScale, textLayerHeight * textScale);

    this.captionCtx.restore();
    this.setActiveCueLayout(
      active.id,
      cueMode,
      { x, y, width: boxWidth, height: boxHeight, widthPercent: resolvedWidthPercent, heightPercent: resolvedHeightPercent },
      layerWidth,
      layerHeight,
      outputWidth,
      outputHeight
    );
  }

  ensureCaptionLayerSize(outputWidth, outputHeight, pixelScale) {
    const layerWidth = Math.max(1, Math.floor(outputWidth / pixelScale));
    const layerHeight = Math.max(1, Math.floor(outputHeight / pixelScale));

    if (this.captionLayer.width !== layerWidth || this.captionLayer.height !== layerHeight) {
      this.captionLayer.width = layerWidth;
      this.captionLayer.height = layerHeight;
      this.metricsCache.clear();
    }

    return { layerWidth, layerHeight };
  }

  getActiveCaption(timeSeconds) {
    const captions = this.getCaptions();
    const editableCueId = this.getEditableCueId();
    if (editableCueId) {
      const editableCue = captions.find((caption) => caption.id === editableCueId);
      if (editableCue && timeSeconds >= editableCue.start && timeSeconds <= editableCue.end) {
        return editableCue;
      }
    }

    let active = null;

    for (const caption of captions) {
      if (timeSeconds >= caption.start && timeSeconds <= caption.end) {
        if (!active || caption.start >= active.start) {
          active = caption;
        }
      }
    }

    return active;
  }

  buildAnimatedText(caption, currentTime, animationStyle, animationDuration) {
    if (animationStyle !== "typewriter") {
      return caption.text;
    }

    const progress = clamp((currentTime - caption.start) / animationDuration, 0, 1);
    const charactersToShow = Math.max(1, Math.floor(caption.text.length * progress));
    return caption.text.slice(0, charactersToShow);
  }

  computeAnimationAlpha(caption, currentTime, animationStyle, animationDuration) {
    if (animationStyle !== "fade") {
      return 1;
    }

    const fadeIn = clamp((currentTime - caption.start) / animationDuration, 0, 1);
    const fadeOut = clamp((caption.end - currentTime) / animationDuration, 0, 1);
    return clamp(Math.min(fadeIn, fadeOut), 0, 1);
  }

  fitMetricsToHeight({ measureFn, minFont, initialFont, maxFont, targetHeight, allowGrow }) {
    const boundedMin = Math.max(1, Math.floor(minFont));
    const boundedMax = Math.max(boundedMin, Math.floor(maxFont));
    let metrics = measureFn(clamp(Math.round(initialFont), boundedMin, boundedMax));

    while (metrics.fitHeight > targetHeight && metrics.fontSize > boundedMin) {
      metrics = measureFn(metrics.fontSize - 1);
    }

    if (!allowGrow) {
      return metrics;
    }

    let low = metrics.fontSize;
    let high = boundedMax;
    let best = metrics;

    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = measureFn(mid);
      if (candidate.fitHeight <= targetHeight) {
        best = candidate;
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    return best;
  }

  resolveCueBoxWidthPercent(caption, fallbackWidthPercent) {
    if (caption && Number.isFinite(caption.boxWidthPercent)) {
      return clamp(caption.boxWidthPercent, 20, 95);
    }
    return clamp(fallbackWidthPercent, 20, 95);
  }

  resolveCueBoxHeightPercent(caption, fallbackHeightPercent) {
    if (caption && Number.isFinite(caption.boxHeightPercent)) {
      return clamp(caption.boxHeightPercent, 6, 80);
    }
    return clamp(fallbackHeightPercent, 6, 80);
  }

  // Safe area clamp so caption UI avoids social-app overlays.
  resolvePlatformSafeBounds(layerWidth, layerHeight, style) {
    if (!style?.usePlatformSafeArea) {
      return null;
    }

    const minX = Math.floor(layerWidth * PLATFORM_SAFE_INSETS.left);
    const maxX = Math.ceil(layerWidth * (1 - PLATFORM_SAFE_INSETS.right));
    const minY = Math.floor(layerHeight * PLATFORM_SAFE_INSETS.top);
    const maxY = Math.ceil(layerHeight * (1 - PLATFORM_SAFE_INSETS.bottom));
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

  resolveCuePosition(caption, defaultX, defaultY, width, height, layerWidth, layerHeight, style = null) {
    let x = defaultX;
    let y = defaultY;

    if (caption && Number.isFinite(caption.positionX)) {
      x = Math.floor((clamp(caption.positionX, 0, 100) / 100) * layerWidth);
    }

    if (caption && Number.isFinite(caption.positionY)) {
      y = Math.floor((clamp(caption.positionY, 0, 100) / 100) * layerHeight);
    }

    const safeBounds = this.resolvePlatformSafeBounds(layerWidth, layerHeight, style);
    const minX = safeBounds ? safeBounds.minX : 0;
    const minY = safeBounds ? safeBounds.minY : 0;
    const maxX = safeBounds ? Math.max(minX, safeBounds.maxX - width) : Math.max(0, layerWidth - width);
    const maxY = safeBounds ? Math.max(minY, safeBounds.maxY - height) : Math.max(0, layerHeight - height);

    x = clamp(x, minX, maxX);
    y = clamp(y, minY, maxY);
    return { x, y };
  }

  setActiveCueLayout(cueId, mode, layout, layerWidth, layerHeight, outputWidth, outputHeight) {
    if (!layout) {
      this.activeCueLayout = null;
      return;
    }

    const scaleX = outputWidth / layerWidth;
    const scaleY = outputHeight / layerHeight;
    const x = layout.x * scaleX;
    const y = layout.y * scaleY;
    const width = layout.width * scaleX;
    const height = layout.height * scaleY;

    this.activeCueLayout = {
      id: cueId,
      mode,
      x,
      y,
      width,
      height,
      widthPercent: Number.isFinite(layout.widthPercent) ? layout.widthPercent : null,
      heightPercent: Number.isFinite(layout.heightPercent)
        ? layout.heightPercent
        : clamp((layout.height / Math.max(1, layerHeight)) * 100, 6, 80),
      handleSize: Math.max(10, Math.min(16, Math.floor(Math.min(width, height) * 0.16)))
    };
  }

  drawSelectedCueOverlay(ctx) {
    if (!this.activeCueLayout) {
      return;
    }

    const style = this.getStyle();
    const isDramatic = this.activeCueLayout.mode === "dramatic";
    const isDialogueLike = this.activeCueLayout.mode === "dialogue" || this.activeCueLayout.mode === "choice";
    const selectedCueId = this.getSelectedCueId();
    const editableCueId = this.getEditableCueId();
    if (isDramatic) {
      if (!selectedCueId || selectedCueId !== this.activeCueLayout.id || !editableCueId || editableCueId !== selectedCueId) {
        return;
      }
    } else if (!isDialogueLike || !style?.manualDialoguePosition) {
      return;
    }

    const { x, y, width, height, handleSize } = this.activeCueLayout;
    if (width <= 0 || height <= 0) {
      return;
    }

    const px = Math.floor(x) + 0.5;
    const py = Math.floor(y) + 0.5;
    const pw = Math.floor(width);
    const ph = Math.floor(height);

    ctx.save();
    ctx.strokeStyle = isDramatic ? "#f1d84a" : "#63d7ff";
    ctx.lineWidth = 1;
    ctx.strokeRect(px, py, pw, ph);

    if (isDramatic) {
      const handleX = Math.floor(x + width - handleSize);
      const handleY = Math.floor(y + height - handleSize);
      ctx.fillStyle = "#f1d84a";
      ctx.fillRect(handleX, handleY, handleSize, handleSize);
      ctx.strokeStyle = "#1f1f1f";
      ctx.lineWidth = 1;
      ctx.strokeRect(handleX + 0.5, handleY + 0.5, handleSize - 1, handleSize - 1);
    }
    ctx.restore();
  }

  getInteractiveCueLayout() {
    if (!this.activeCueLayout) {
      return null;
    }
    return { ...this.activeCueLayout };
  }

  normalizeCueMode(mode) {
    if (mode === "choice" || mode === "dramatic") {
      return mode;
    }
    return "dialogue";
  }

  parseChoiceText(text) {
    const rows = String(text || "")
      .split("\n")
      .map((line) => line.replace(/\r/g, ""));
    const splitIndex = rows.findIndex((line) => line.trim() === "");

    let promptRows = [];
    let optionRows = [];

    if (splitIndex >= 0) {
      promptRows = rows.slice(0, splitIndex).map((line) => line.trim()).filter(Boolean);
      optionRows = rows.slice(splitIndex + 1).map((line) => line.trim()).filter(Boolean);
    } else {
      const nonEmptyRows = rows.map((line) => line.trim()).filter(Boolean);
      if (nonEmptyRows.length > 1) {
        promptRows = [nonEmptyRows[0]];
        optionRows = nonEmptyRows.slice(1);
      }
    }

    if (!optionRows.length) {
      return null;
    }

    let selectedIndex = optionRows.findIndex((line) => /^\s*>/.test(line));
    if (selectedIndex < 0) {
      selectedIndex = 0;
    }

    const cleanedOptions = optionRows
      .map((line) => line.replace(/^\s*\>\s*/, "").trim())
      .filter(Boolean);
    if (!cleanedOptions.length) {
      return null;
    }
    selectedIndex = clamp(selectedIndex, 0, cleanedOptions.length - 1);

    return {
      prompt: promptRows.join(" ").trim(),
      selectedIndex,
      options: cleanedOptions
    };
  }

  buildChoiceLines(ctx, text, maxWidth, blinkOn) {
    const parsed = this.parseChoiceText(text);
    if (!parsed) {
      return this.wrapText(ctx, text, maxWidth);
    }

    const selectedPrefix = "> ";
    const neutralPrefix = "  ";
    const lines = [];
    const indicatorWidth = Math.max(4, ctx.measureText(selectedPrefix).width);
    const optionWidth = Math.max(8, maxWidth - indicatorWidth);

    if (parsed.prompt) {
      lines.push(...this.wrapText(ctx, parsed.prompt, maxWidth));
      lines.push("");
    }

    for (let index = 0; index < parsed.options.length; index += 1) {
      const option = parsed.options[index];
      const selected = index === parsed.selectedIndex;
      const prefix = selected && blinkOn ? selectedPrefix : neutralPrefix;
      const optionLines = this.wrapText(ctx, option, optionWidth);
      const safeLines = optionLines.length ? optionLines : [""];

      for (let lineIndex = 0; lineIndex < safeLines.length; lineIndex += 1) {
        const content = safeLines[lineIndex];
        lines.push(`${lineIndex === 0 ? prefix : neutralPrefix}${content}`);
      }
    }

    return lines.length ? lines : [""];
  }

  renderDramaticCaption(ctx, text, style, layerWidth, layerHeight, alpha, showBackdrop = true, caption = null) {
    const content = String(text || "").trim();
    if (!content) {
      return null;
    }

    const safeBounds = this.resolvePlatformSafeBounds(layerWidth, layerHeight, style);
    const boxWidthPercent = this.resolveCueBoxWidthPercent(caption, style.boxWidthPercent);
    const boxHeightPercent = this.resolveCueBoxHeightPercent(caption, 14);
    const maxBandWidth = safeBounds ? Math.max(16, safeBounds.width) : layerWidth;
    const maxBandHeight = safeBounds ? Math.max(12, safeBounds.height) : layerHeight;
    const boxWidth = clamp(Math.floor(layerWidth * (boxWidthPercent / 100)), 16, maxBandWidth);
    const maxTextWidth = Math.max(16, boxWidth - 8);
    const hasFixedHeight = Number.isFinite(caption?.boxHeightPercent);
    const targetBandHeight = clamp(Math.floor(layerHeight * (boxHeightPercent / 100)), 12, maxBandHeight);

    const measureDramatic = (candidateFontSize) => {
      const safeFontSize = clamp(Math.round(candidateFontSize), 10, 220);
      ctx.font = `${safeFontSize}px "Press Start 2P", monospace`;
      const dramaticLineHeight = safeFontSize + 5;
      const dramaticPadding = Math.max(5, Math.floor(safeFontSize * 0.4));
      const dramaticLines = this.wrapText(ctx, content, maxTextWidth);
      const dramaticBlockHeight = dramaticLines.length * dramaticLineHeight;
      const dramaticNaturalBandHeight = dramaticBlockHeight + dramaticPadding * 2;
      return {
        fontSize: safeFontSize,
        lineHeight: dramaticLineHeight,
        bandPadding: dramaticPadding,
        lines: dramaticLines,
        blockHeight: dramaticBlockHeight,
        naturalBandHeight: dramaticNaturalBandHeight,
        fitHeight: dramaticNaturalBandHeight
      };
    };

    let metrics = null;
    const dramaticCacheKey = this.buildCacheKey([
      "dramatic-metrics",
      caption?.id ?? null,
      content,
      boxWidth,
      boxWidthPercent,
      boxHeightPercent,
      targetBandHeight,
      hasFixedHeight ? 1 : 0,
      style.fontSize,
      layerWidth,
      layerHeight
    ]);
    metrics = this.getCachedMetrics(dramaticCacheKey, () => {
      if (hasFixedHeight) {
        const maxDramaticFont = Math.min(120, Math.max(10, Math.floor(targetBandHeight * 0.9)));
        return this.fitMetricsToHeight({
          measureFn: measureDramatic,
          minFont: 10,
          initialFont: Math.round(style.fontSize * 2.7),
          maxFont: maxDramaticFont,
          targetHeight: targetBandHeight,
          allowGrow: true
        });
      }

      let measured = measureDramatic(Math.round(style.fontSize * 2.7));
      while (measured.blockHeight > Math.floor(layerHeight * 0.42) && measured.fontSize > 10) {
        measured = measureDramatic(measured.fontSize - 1);
      }
      return measured;
    });

    const fontSize = metrics.fontSize;
    const lineHeight = metrics.lineHeight;
    const bandPadding = metrics.bandPadding;
    const lines = metrics.lines;
    const naturalBandHeight = metrics.naturalBandHeight;
    const bandHeight = hasFixedHeight ? targetBandHeight : naturalBandHeight;
    const resolvedWidthPercent = clamp((boxWidth / Math.max(1, layerWidth)) * 100, 0.5, 95);
    const resolvedHeightPercent = clamp((bandHeight / Math.max(1, layerHeight)) * 100, 0.5, 80);
    const defaultX = Math.floor((layerWidth - boxWidth) / 2);
    const defaultY = Math.max(2, Math.floor(layerHeight * 0.55 - bandHeight / 2));
    const { x: bandLeft, y: bandTop } = this.resolveCuePosition(
      caption,
      defaultX,
      defaultY,
      boxWidth,
      bandHeight,
      layerWidth,
      layerHeight,
      style
    );
    const bandWidth = boxWidth;

    ctx.save();
    ctx.globalAlpha = alpha;
    if (showBackdrop) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.34)";
      ctx.fillRect(bandLeft, bandTop, bandWidth, bandHeight);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = `${fontSize}px "Press Start 2P", monospace`;

    const textX = Math.floor(bandLeft + bandWidth / 2);
    const textStartY = bandTop + bandPadding;
    const textColor = style.textColor || "#f8f8f8";
    const useOutline = this.isVeryLightColor(textColor);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const y = textStartY + index * lineHeight;
      if (useOutline) {
        ctx.fillStyle = "#000000";
        ctx.fillText(line, textX - 1, y);
        ctx.fillText(line, textX + 1, y);
        ctx.fillText(line, textX, y - 1);
        ctx.fillText(line, textX, y + 1);
      }
      ctx.fillStyle = textColor;
      ctx.fillText(line, textX, y);
    }

    ctx.restore();
    return {
      x: bandLeft,
      y: bandTop,
      width: bandWidth,
      height: bandHeight,
      widthPercent: resolvedWidthPercent,
      heightPercent: resolvedHeightPercent
    };
  }

  isVeryLightColor(color) {
    const value = String(color || "").trim();
    if (!value) {
      return false;
    }

    const hex = value.replace("#", "");
    if (!/^[0-9a-fA-F]{3,8}$/.test(hex)) {
      return false;
    }

    const normalized =
      hex.length === 3
        ? hex
            .split("")
            .map((char) => `${char}${char}`)
            .join("")
        : hex.slice(0, 6);

    const r = parseInt(normalized.slice(0, 2), 16);
    const g = parseInt(normalized.slice(2, 4), 16);
    const b = parseInt(normalized.slice(4, 6), 16);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance >= 0.72;
  }

  wrapText(ctx, text, maxWidth) {
    const lines = [];
    const paragraphs = String(text || "").split("\n");

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim();

      if (!trimmed) {
        lines.push("");
        continue;
      }

      const words = trimmed.split(/\s+/);
      let line = "";

      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;

        if (ctx.measureText(candidate).width <= maxWidth) {
          line = candidate;
          continue;
        }

        if (line) {
          lines.push(line);
          line = word;
          continue;
        }

        let chunk = "";
        for (const character of word) {
          const chunkCandidate = `${chunk}${character}`;
          if (ctx.measureText(chunkCandidate).width <= maxWidth) {
            chunk = chunkCandidate;
          } else {
            if (chunk) {
              lines.push(chunk);
            }
            chunk = character;
          }
        }
        line = chunk;
      }

      if (line) {
        lines.push(line);
      }
    }

    return lines.length ? lines : [""];
  }

  drawPixelBorder(ctx, x, y, width, height, color) {
    if (width <= 0 || height <= 0) {
      return;
    }

    ctx.fillStyle = color;
    ctx.fillRect(x, y, width, 1);
    ctx.fillRect(x, y + height - 1, width, 1);
    ctx.fillRect(x, y, 1, height);
    ctx.fillRect(x + width - 1, y, 1, height);
  }

  drawDialogueWindow(ctx, x, y, width, height, boxStyle) {
    ctx.fillStyle = "#000000";
    ctx.fillRect(x, y, width, height);

    if (boxStyle === "minimal_white") {
      this.drawPixelBorder(ctx, x, y, width, height, "#ffffff");
      return;
    }

    if (boxStyle === "nes_classic") {
      this.drawPixelBorder(ctx, x, y, width, height, "#ffffff");
      if (width > 6 && height > 6) {
        this.drawPixelBorder(ctx, x + 2, y + 2, width - 4, height - 4, "#ffffff");
      }
      return;
    }

    // Reference style: stepped white frame with black outer corners.
    this.drawPixelBorder(ctx, x - 2, y - 2, width + 4, height + 4, "#000000");
    this.drawPixelBorder(ctx, x - 1, y - 1, width + 2, height + 2, "#000000");
    this.drawPixelBorder(ctx, x, y, width, height, "#ffffff");
    this.drawPixelBorder(ctx, x + 1, y + 1, width - 2, height - 2, "#ffffff");
    this.drawPixelBorder(ctx, x + 2, y + 2, width - 4, height - 4, "#000000");

    ctx.fillStyle = "#000000";
    ctx.fillRect(x - 3, y - 2, 2, 1);
    ctx.fillRect(x - 2, y - 3, 1, 1);
    ctx.fillRect(x + width + 1, y - 2, 2, 1);
    ctx.fillRect(x + width + 1, y - 3, 1, 1);
    ctx.fillRect(x - 3, y + height + 1, 2, 1);
    ctx.fillRect(x - 2, y + height + 2, 1, 1);
    ctx.fillRect(x + width + 1, y + height + 1, 2, 1);
    ctx.fillRect(x + width + 1, y + height + 2, 1, 1);
  }

  drawDownArrow(ctx, x, y, color, width = 7) {
    let normalizedWidth = Math.max(3, Math.round(width));
    if (normalizedWidth % 2 === 0) {
      normalizedWidth += 1;
    }
    const rows = Math.floor((normalizedWidth + 1) / 2);

    ctx.fillStyle = color;
    for (let row = 0; row < rows; row += 1) {
      const inset = row;
      const rowWidth = normalizedWidth - inset * 2;
      if (rowWidth <= 0) {
        break;
      }
      ctx.fillRect(x + inset, y + row, rowWidth, 1);
    }
  }
}
