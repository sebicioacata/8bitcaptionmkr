import { clamp } from "./utils.js";

export class MiniTimeline {
  constructor({
    container,
    getDuration,
    getCurrentTime,
    getCaptions,
    getSelectedCueId,
    formatTime,
    onCueChange,
    onCueSelect,
    onSeek
  }) {
    this.container = container;
    this.getDuration = getDuration;
    this.getCurrentTime = getCurrentTime;
    this.getCaptions = getCaptions;
    this.getSelectedCueId = getSelectedCueId;
    this.formatTime = formatTime;
    this.onCueChange = onCueChange;
    this.onCueSelect = onCueSelect;
    this.onSeek = onSeek;

    this.drag = null;
    this.bindEvents();
  }

  bindEvents() {
    this.container.addEventListener("pointerdown", this.handlePointerDown.bind(this));
    this.container.addEventListener("pointermove", this.handlePointerMove.bind(this));
    this.container.addEventListener("pointerup", this.handlePointerUp.bind(this));
    this.container.addEventListener("pointercancel", this.handlePointerCancel.bind(this));
  }

  render() {
    const duration = this.getDuration();
    this.container.innerHTML = "";

    if (!duration) {
      const empty = document.createElement("p");
      empty.className = "mini-empty";
      empty.textContent = "Load a video to view timeline cues.";
      this.container.appendChild(empty);
      return;
    }

    const captions = this.getCaptions();
    const selectedCueId = typeof this.getSelectedCueId === "function" ? this.getSelectedCueId() : null;
    for (let index = 0; index < captions.length; index += 1) {
      const caption = captions[index];
      const segment = document.createElement("div");
      segment.className = "mini-caption-segment";
      if (caption.id === selectedCueId) {
        segment.classList.add("is-selected");
      }
      segment.dataset.id = String(caption.id);
      segment.style.left = `${(clamp(caption.start / duration, 0, 1) * 100).toFixed(3)}%`;
      segment.style.width = `${Math.max(1.2, ((caption.end - caption.start) / duration) * 100).toFixed(3)}%`;
      segment.title = `${this.formatTime(caption.start)} - ${this.formatTime(caption.end)} | ${caption.text}`;

      const leftHandle = document.createElement("button");
      leftHandle.type = "button";
      leftHandle.className = "mini-handle mini-handle-left";
      leftHandle.setAttribute("aria-label", "Drag cue start");

      const rightHandle = document.createElement("button");
      rightHandle.type = "button";
      rightHandle.className = "mini-handle mini-handle-right";
      rightHandle.setAttribute("aria-label", "Drag cue end");

      const label = document.createElement("span");
      label.className = "mini-caption-index";
      label.textContent = String(index + 1);

      segment.appendChild(leftHandle);
      segment.appendChild(label);
      segment.appendChild(rightHandle);
      this.container.appendChild(segment);
    }

    const playhead = document.createElement("div");
    playhead.className = "mini-playhead";
    playhead.setAttribute("aria-label", "Current time playhead");
    playhead.title = "Drag to scrub";
    this.container.appendChild(playhead);
    this.updatePlayhead();
  }

  updatePlayhead() {
    const playhead = this.container.querySelector(".mini-playhead");
    if (!playhead) {
      return;
    }

    const duration = this.getDuration();
    if (!duration) {
      playhead.style.display = "none";
      return;
    }

    playhead.style.display = "block";
    const progress = clamp(this.getCurrentTime() / duration, 0, 1);
    playhead.style.left = `${(progress * 100).toFixed(3)}%`;
  }

  findCaptionById(id) {
    const captions = this.getCaptions();
    return captions.find((caption) => caption.id === id) || null;
  }

  timeFromClientX(clientX) {
    const duration = this.getDuration();
    const rect = this.container.getBoundingClientRect();
    if (!duration || rect.width <= 0) {
      return 0;
    }

    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return ratio * duration;
  }

  handlePointerDown(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    const segment = target.closest(".mini-caption-segment");
    if (!(segment instanceof HTMLElement)) {
      const duration = this.getDuration();
      if (!duration) {
        return;
      }

      const scrubTime = this.timeFromClientX(event.clientX);
      void this.onSeek(scrubTime, { source: "timeline", scrubbing: true });
      event.preventDefault();

      this.drag = {
        pointerId: event.pointerId,
        mode: "playhead",
        moved: false
      };

      this.container.setPointerCapture(event.pointerId);
      return;
    }

    const duration = this.getDuration();
    if (!duration) {
      return;
    }

    const id = parseInt(segment.dataset.id || "", 10);
    const caption = this.findCaptionById(id);
    if (!caption) {
      return;
    }

    let mode = "move";
    if (target instanceof HTMLElement) {
      if (target.classList.contains("mini-handle-left")) {
        mode = "left";
      } else if (target.classList.contains("mini-handle-right")) {
        mode = "right";
      }
    }

    event.preventDefault();
    this.drag = {
      pointerId: event.pointerId,
      captionId: id,
      mode,
      pointerStartX: event.clientX,
      originalStart: caption.start,
      originalEnd: caption.end,
      moved: false
    };

    this.container.setPointerCapture(event.pointerId);
  }

  handlePointerMove(event) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) {
      return;
    }

    if (this.drag.mode === "playhead") {
      this.drag.moved = true;
      const scrubTime = this.timeFromClientX(event.clientX);
      void this.onSeek(scrubTime, { source: "timeline", scrubbing: true });
      return;
    }

    const duration = this.getDuration();
    const caption = this.findCaptionById(this.drag.captionId);
    if (!duration || !caption) {
      return;
    }

    const rect = this.container.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }

    const deltaTime = ((event.clientX - this.drag.pointerStartX) / rect.width) * duration;
    const minDuration = 0.1;

    let nextStart = this.drag.originalStart;
    let nextEnd = this.drag.originalEnd;

    if (this.drag.mode === "move") {
      const cueDuration = this.drag.originalEnd - this.drag.originalStart;
      nextStart = clamp(this.drag.originalStart + deltaTime, 0, Math.max(0, duration - cueDuration));
      nextEnd = nextStart + cueDuration;
    } else if (this.drag.mode === "left") {
      nextStart = clamp(this.drag.originalStart + deltaTime, 0, this.drag.originalEnd - minDuration);
    } else if (this.drag.mode === "right") {
      nextEnd = clamp(this.drag.originalEnd + deltaTime, this.drag.originalStart + minDuration, duration);
    }

    if (Math.abs(caption.start - nextStart) <= 0.001 && Math.abs(caption.end - nextEnd) <= 0.001) {
      return;
    }

    this.drag.moved = true;
    this.onCueChange({
      id: caption.id,
      start: nextStart,
      end: nextEnd,
      final: false
    });

    this.render();
  }

  async handlePointerUp(event) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) {
      return;
    }

    const drag = this.drag;
    this.drag = null;

    if (this.container.hasPointerCapture(event.pointerId)) {
      this.container.releasePointerCapture(event.pointerId);
    }

    if (drag.mode === "playhead") {
      const scrubTime = this.timeFromClientX(event.clientX);
      await this.onSeek(scrubTime, { source: "timeline", scrubbing: false });
      this.render();
      return;
    }

    const caption = this.findCaptionById(drag.captionId);
    if (!caption) {
      this.render();
      return;
    }

    if (drag.moved) {
      this.onCueChange({
        id: caption.id,
        start: caption.start,
        end: caption.end,
        final: true
      });
    } else {
      if (typeof this.onCueSelect === "function") {
        this.onCueSelect(caption.id);
      }
      await this.onSeek(caption.start);
    }

    this.render();
  }

  handlePointerCancel(event) {
    if (!this.drag) {
      return;
    }

    if (this.container.hasPointerCapture(this.drag.pointerId)) {
      this.container.releasePointerCapture(this.drag.pointerId);
    }

    if (this.drag.mode !== "playhead" && this.drag.moved) {
      const caption = this.findCaptionById(this.drag.captionId);
      if (caption) {
        this.onCueChange({
          id: caption.id,
          start: caption.start,
          end: caption.end,
          final: true
        });
      }
    }

    this.drag = null;
    this.render();
  }
}
