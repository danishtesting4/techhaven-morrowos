(() => {
  "use strict";

  const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
  const MAX_IMAGES = 1;
  const MAX_IMAGE_BYTES = 1000000;
  const MAX_TEXT_LENGTH = 2000;
  const MAX_RENDERED_MESSAGES = 80;
  const REQUEST_TIMEOUT_MS = 20000;
  const FALLBACK_POLL_MS = 15000;
  const USERNAME_KEY = "morrowos.boot.username";
  const CLIENT_ID_KEY = "morrowos.boot.client";
  const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,23}$/;

  const elements = {
    form: document.getElementById("chat-form"),
    input: document.getElementById("message-input"),
    imageInput: document.getElementById("image-input"),
    imageCounter: document.getElementById("image-counter"),
    attachButton: document.getElementById("attach-button"),
    sendButton: document.getElementById("send-button"),
    messages: document.getElementById("chat-messages"),
    attachmentPreview: document.getElementById("attachment-preview"),
    chatShell: document.getElementById("chat-shell"),
    status: document.getElementById("chat-status"),
    presence: document.getElementById("chat-presence"),
    navLinks: document.getElementById("site-navigation"),
    navToggle: document.getElementById("nav-toggle"),
    loginScreen: document.getElementById("login-screen"),
    loginForm: document.getElementById("login-form"),
    usernameInput: document.getElementById("username-input"),
    loginError: document.getElementById("login-error"),
    userChip: document.getElementById("user-chip"),
    userName: document.getElementById("user-name"),
    userAvatar: document.getElementById("user-avatar")
  };

  let currentUsername = "";
  let clientId = "";
  let lastSeq = 0;
  let pendingImages = [];
  let isSending = false;
  let isReadingImages = false;
  let dragDepth = 0;
  let source = null;
  let fallbackTimer = null;
  let onlineCount = 0;
  const seenIds = new Set();

  function getStoredValue(key) {
    try {
      return window.localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  }

  function setStoredValue(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      return;
    }
  }

  function clearStoredValue(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      return;
    }
  }

  function createId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  }

  function resolveClientId() {
    const stored = getStoredValue(CLIENT_ID_KEY);
    if (/^[A-Za-z0-9_-]{8,64}$/.test(stored)) {
      return stored;
    }
    const generated = createId().replace(/-/g, "");
    setStoredValue(CLIENT_ID_KEY, generated);
    return generated;
  }

  function validateUsername(value) {
    const name = value.trim().replace(/\s+/g, " ");
    if (!name) {
      return { ok: false, error: "Enter a username to continue." };
    }
    if (!USERNAME_PATTERN.test(name)) {
      return { ok: false, error: "Use 2 to 24 letters, numbers, spaces, dots, dashes or underscores." };
    }
    return { ok: true, name };
  }

  function formatBytes(bytes) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function setStatus(message, state = "") {
    elements.status.textContent = message;
    elements.status.dataset.state = state;
  }

  function setOnline(count) {
    onlineCount = Number(count) || 0;
    if (!elements.presence) {
      return;
    }
    elements.presence.textContent = onlineCount <= 1 ? "1 person here" : `${onlineCount} people here`;
  }

  function showLogin() {
    elements.loginScreen.hidden = false;
    elements.chatShell.hidden = true;
  }

  function showChat() {
    elements.loginScreen.hidden = true;
    elements.chatShell.hidden = false;
    elements.userName.textContent = currentUsername;
    elements.userAvatar.textContent = currentUsername.slice(0, 1).toUpperCase();
    elements.usernameInput.value = currentUsername;
  }

  function renderWelcome() {
    const notice = document.createElement("article");
    notice.className = "message message-system";
    const column = document.createElement("div");
    column.className = "message-column";
    const content = document.createElement("div");
    content.className = "message-content";
    content.textContent = "This is a shared room. Anything you send here is visible to everyone who is connected, and messages disappear after 24 hours.";
    column.append(content);
    notice.append(column);
    elements.messages.replaceChildren(notice);
  }

  function resizeInput() {
    elements.input.style.height = "auto";
    elements.input.style.height = `${Math.min(elements.input.scrollHeight, 144)}px`;
    updateControls();
  }

  function updateControls() {
    const textIsEmpty = elements.input.value.trim().length === 0;
    const busy = isSending || isReadingImages;
    elements.attachButton.disabled = busy || pendingImages.length >= MAX_IMAGES;
    elements.imageInput.disabled = isSending;
    elements.input.disabled = isSending;
    elements.sendButton.disabled = busy || (textIsEmpty && pendingImages.length === 0);
    if (elements.imageCounter) {
      elements.imageCounter.textContent = `${pendingImages.length} of ${MAX_IMAGES} picture attached`;
    }
  }

  function scrollToLatest() {
    window.requestAnimationFrame(() => {
      elements.messages.scrollTop = elements.messages.scrollHeight;
    });
  }

  function isNearBottom() {
    return elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 140;
  }

  function createMessageElement(message) {
    const isOwn = message.username === currentUsername;
    const article = document.createElement("article");
    article.className = `message message-person${isOwn ? " is-own" : ""}`;
    article.dataset.messageId = String(message.id);

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = (message.username || "?").slice(0, 1).toUpperCase();

    const column = document.createElement("div");
    column.className = "message-column";

    const meta = document.createElement("div");
    meta.className = "message-meta";
    const name = document.createElement("span");
    name.textContent = isOwn ? `${message.username} (you)` : message.username;
    const time = document.createElement("time");
    const stamp = new Date((message.createdAt || Math.floor(Date.now() / 1000)) * 1000);
    time.dateTime = stamp.toISOString();
    time.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(stamp);
    meta.append(name, time);
    column.append(meta);

    if (message.text) {
      const text = document.createElement("div");
      text.className = "message-content";
      text.textContent = message.text;
      column.append(text);
    }

    if (message.imageId) {
      const grid = document.createElement("div");
      grid.className = "message-images";
      const image = document.createElement("img");
      image.src = `/api/chat?image=${encodeURIComponent(message.imageId)}`;
      image.alt = `Picture sent by ${message.username}`;
      image.loading = "lazy";
      grid.append(image);
      column.append(grid);
    }

    article.append(avatar, column);
    return article;
  }

  function appendMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }
    const nearBottom = isNearBottom();
    const fragment = document.createDocumentFragment();
    let added = 0;

    messages.forEach((message) => {
      if (!message || !message.id || seenIds.has(message.id)) {
        return;
      }
      seenIds.add(message.id);
      if (message.id > lastSeq) {
        lastSeq = message.id;
      }
      fragment.append(createMessageElement(message));
      added += 1;
    });

    if (added === 0) {
      return;
    }
    elements.messages.append(fragment);

    while (elements.messages.children.length > MAX_RENDERED_MESSAGES) {
      const first = elements.messages.firstElementChild;
      if (!first) {
        break;
      }
      elements.messages.firstElementChild.remove();
    }

    if (nearBottom) {
      scrollToLatest();
    }
  }

  function appendSystemMessage(text, isError) {
    const article = document.createElement("article");
    article.className = `message message-system${isError ? " message-error" : ""}`;
    const column = document.createElement("div");
    column.className = "message-column";
    const content = document.createElement("div");
    content.className = "message-content";
    content.textContent = text;
    column.append(content);
    article.append(column);
    elements.messages.append(article);
    scrollToLatest();
  }

  function renderAttachments() {
    elements.attachmentPreview.replaceChildren();
    pendingImages.forEach((image) => {
      const item = document.createElement("div");
      item.className = "attachment-item";

      const preview = document.createElement("img");
      preview.src = image.dataUrl;
      preview.alt = `Preview of ${image.name}`;

      const details = document.createElement("span");
      details.textContent = `${image.name} · ${formatBytes(image.size)}`;

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = "×";
      removeButton.setAttribute("aria-label", `Remove ${image.name}`);
      removeButton.addEventListener("click", () => {
        pendingImages = pendingImages.filter((item) => item.id !== image.id);
        renderAttachments();
        updateControls();
      });

      item.append(preview, details, removeButton);
      elements.attachmentPreview.append(item);
    });
    elements.attachmentPreview.hidden = pendingImages.length === 0;
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  async function addFiles(fileList) {
    if (isSending || isReadingImages) {
      return;
    }
    const files = Array.from(fileList);
    if (files.length === 0) {
      return;
    }
    elements.imageInput.value = "";

    const file = files.find((candidate) => ALLOWED_IMAGE_TYPES.has(candidate.type) && candidate.size > 0);
    if (!file) {
      setStatus("Attach a JPG, PNG or WebP picture", "error");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setStatus("Pictures must be 1 MB or less", "error");
      return;
    }
    if (pendingImages.length >= MAX_IMAGES) {
      setStatus("You can attach one picture per message", "error");
      return;
    }

    isReadingImages = true;
    updateControls();
    setStatus("Preparing picture...");

    try {
      const dataUrl = await readFileAsDataUrl(file);
      pendingImages = [
        {
          id: createId(),
          name: file.name || "picture",
          size: file.size,
          type: file.type,
          base64: String(dataUrl).split(",")[1] || ""
        }
      ];
      renderAttachments();
      setStatus("Picture ready to send");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not read that picture", "error");
    } finally {
      isReadingImages = false;
      elements.imageInput.value = "";
      updateControls();
    }
  }

  function setSending(value) {
    isSending = value;
    elements.messages.setAttribute("aria-busy", String(value));
    updateControls();
  }

  function getRequestError(error) {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return "Could not reach the chat server. Check your connection.";
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!currentUsername) {
      showLogin();
      return;
    }
    if (isSending || isReadingImages) {
      return;
    }

    const text = elements.input.value.trim().slice(0, MAX_TEXT_LENGTH);
    const image = pendingImages[0] || null;
    if (!text && !image) {
      return;
    }

    setSending(true);
    setStatus("Sending...");

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          username: currentUsername,
          text,
          image: image ? { mime: image.type, base64: image.base64 } : null
        }),
        signal: controller.signal
      });

      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (!response.ok) {
        throw new Error(data.error || "Could not send that message.");
      }

      elements.input.value = "";
      pendingImages = [];
      renderAttachments();
      resizeInput();

      if (data.message) {
        appendMessages([data.message]);
      } else {
        pollOnce();
      }
      setStatus(isStreamOpen() ? "Live" : "Reconnecting...", isStreamOpen() ? "success" : "");
    } catch (error) {
      const message = error && error.name === "AbortError" ? "That took too long. Please try again." : getRequestError(error);
      appendSystemMessage(message, true);
      setStatus("Send failed · Try again", "error");
    } finally {
      window.clearTimeout(timeout);
      setSending(false);
      elements.input.focus();
    }
  }

  function isStreamOpen() {
    return Boolean(source) && source.readyState === 1;
  }

  function connectStream() {
    if (source) {
      source.close();
      source = null;
    }
    setStatus("Connecting...");
    try {
      source = new EventSource(`/api/chat?client=${encodeURIComponent(clientId)}&since=${lastSeq}`);
    } catch {
      setStatus("Offline · retrying", "error");
      return;
    }

    source.addEventListener("open", () => {
      setStatus("Live", "success");
    });

    source.addEventListener("message", (event) => {
      let data = {};
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      appendMessages(data.messages);
    });

    source.addEventListener("presence", (event) => {
      let data = {};
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      setOnline(data.online);
    });

    source.addEventListener("stream-error", (event) => {
      let data = {};
      try {
        data = JSON.parse(event.data);
      } catch {
        data = {};
      }
      appendSystemMessage(data.message || "Could not load the room yet.", true);
    });

    source.addEventListener("error", () => {
      if (!isStreamOpen()) {
        setStatus("Reconnecting...", "error");
      }
    });
  }

  async function pollOnce() {
    try {
      const response = await fetch(
        `/api/chat?mode=poll&client=${encodeURIComponent(clientId)}&since=${lastSeq}`,
        { headers: { Accept: "application/json" } }
      );
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      appendMessages(data.messages);
      setOnline(data.online);
    } catch {
      return;
    }
  }

  function startFallbackPolling() {
    if (fallbackTimer) {
      return;
    }
    fallbackTimer = window.setInterval(() => {
      if (!isStreamOpen()) {
        pollOnce();
      }
    }, FALLBACK_POLL_MS);
  }

  function enterChat(name) {
    currentUsername = name;
    setStoredValue(USERNAME_KEY, name);
    lastSeq = 0;
    seenIds.clear();
    pendingImages = [];
    elements.input.value = "";
    renderAttachments();
    renderWelcome();
    resizeInput();
    showChat();
    setOnline(0);
    connectStream();
    startFallbackPolling();
    setStatus("Connecting...");
    elements.input.focus();
  }

  function exitChat() {
    if (source) {
      source.close();
      source = null;
    }
    if (fallbackTimer) {
      window.clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
    clearStoredValue(USERNAME_KEY);
    currentUsername = "";
    lastSeq = 0;
    seenIds.clear();
    pendingImages = [];
    elements.input.value = "";
    renderAttachments();
    showLogin();
    elements.loginError.hidden = true;
    elements.usernameInput.focus();
  }

  function hasDraggedFiles(event) {
    return Array.from(event.dataTransfer && event.dataTransfer.types ? event.dataTransfer.types : []).includes("Files");
  }

  elements.form.addEventListener("submit", sendMessage);
  elements.input.addEventListener("input", resizeInput);
  elements.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      elements.form.requestSubmit();
    }
  });

  elements.loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const result = validateUsername(elements.usernameInput.value);
    if (!result.ok) {
      elements.loginError.textContent = result.error;
      elements.loginError.hidden = false;
      elements.usernameInput.focus();
      return;
    }
    elements.loginError.hidden = true;
    enterChat(result.name);
  });

  elements.usernameInput.addEventListener("input", () => {
    elements.loginError.hidden = true;
  });

  elements.userChip.addEventListener("click", () => {
    if (isSending) {
      return;
    }
    if (!window.confirm("Leave the room and choose a different username?")) {
      return;
    }
    exitChat();
  });

  elements.attachButton.addEventListener("click", () => elements.imageInput.click());
  elements.imageInput.addEventListener("change", () => addFiles(elements.imageInput.files));

  elements.input.addEventListener("paste", (event) => {
    const clipboard = event.clipboardData;
    if (!clipboard) {
      return;
    }
    const files = Array.from(clipboard.files || []);
    const images = files.filter((file) => ALLOWED_IMAGE_TYPES.has(file.type) && file.size > 0);
    const pastedText = String(clipboard.getData("text/plain") || "").trim();
    if (pastedText) {
      const current = elements.input.value;
      elements.input.value = `${current}${current ? " " : ""}${pastedText}`.slice(0, MAX_TEXT_LENGTH);
      resizeInput();
    }
    if (images.length > 0) {
      event.preventDefault();
      addFiles(images);
    }
  });

  elements.chatShell.addEventListener("dragenter", (event) => {
    if (!hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepth += 1;
    elements.chatShell.classList.add("is-dragging");
  });

  elements.chatShell.addEventListener("dragover", (event) => {
    if (hasDraggedFiles(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  });

  elements.chatShell.addEventListener("dragleave", (event) => {
    if (!hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      elements.chatShell.classList.remove("is-dragging");
    }
  });

  elements.chatShell.addEventListener("drop", (event) => {
    if (!hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepth = 0;
    elements.chatShell.classList.remove("is-dragging");
    addFiles(event.dataTransfer.files);
  });

  elements.navToggle.addEventListener("click", () => {
    const isOpen = elements.navLinks.classList.toggle("open");
    elements.navToggle.setAttribute("aria-expanded", String(isOpen));
  });

  clientId = resolveClientId();
  const storedResult = validateUsername(getStoredValue(USERNAME_KEY));
  if (storedResult.ok) {
    enterChat(storedResult.name);
  } else {
    showLogin();
    elements.usernameInput.focus();
  }
})();
