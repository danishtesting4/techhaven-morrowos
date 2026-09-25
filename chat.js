(() => {
  "use strict";

  const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
  const MAX_IMAGES = 3;
  const MAX_TOTAL_IMAGE_BYTES = 2500000;
  const MAX_HISTORY_MESSAGES = 20;
  const REQUEST_TIMEOUT_MS = 62000;
  const USERNAME_KEY = "morrowos.boot.username";
  const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,23}$/;

  const elements = {
    form: document.getElementById("chat-form"),
    input: document.getElementById("message-input"),
    imageInput: document.getElementById("image-input"),
    imageCounter: document.getElementById("image-counter"),
    attachButton: document.getElementById("attach-button"),
    sendButton: document.getElementById("send-button"),
    clearButton: document.getElementById("clear-chat"),
    messages: document.getElementById("chat-messages"),
    attachmentPreview: document.getElementById("attachment-preview"),
    chatShell: document.getElementById("chat-shell"),
    status: document.getElementById("chat-status"),
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

  let conversation = [];
  let pendingImages = [];
  let isSending = false;
  let isReadingImages = false;
  let isComposingRequest = false;
  let isComposingResponse = false;
  let dragDepth = 0;
  let currentUsername = "";

  function getStoredUsername() {
    try {
      return window.localStorage.getItem(USERNAME_KEY) || "";
    } catch {
      return "";
    }
  }

  function storeUsername(name) {
    try {
      window.localStorage.setItem(USERNAME_KEY, name);
    } catch {
      return;
    }
  }

  function clearStoredUsername() {
    try {
      window.localStorage.removeItem(USERNAME_KEY);
    } catch {
      return;
    }
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

  function enterChat(name) {
    currentUsername = name;
    storeUsername(name);
    conversation = [];
    pendingImages = [];
    elements.input.value = "";
    renderAttachments();
    renderWelcome();
    resizeInput();
    showChat();
    setStatus("Ready");
    elements.input.focus();
  }

  function exitChat() {
    clearStoredUsername();
    currentUsername = "";
    conversation = [];
    pendingImages = [];
    elements.input.value = "";
    renderAttachments();
    showLogin();
    elements.loginError.hidden = true;
    elements.usernameInput.focus();
  }

  function createId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

  function setSending(value) {
    isSending = value;
    elements.messages.setAttribute("aria-busy", String(value));
    updateControls();
  }

  function updateControls() {
    const textIsEmpty = elements.input.value.trim().length === 0;
    const busy = isSending || isReadingImages;
    elements.attachButton.disabled = busy || pendingImages.length >= MAX_IMAGES;
    elements.imageInput.disabled = isSending;
    elements.input.disabled = isSending;
    elements.input.setAttribute("aria-disabled", String(isSending));
    elements.sendButton.disabled = busy || (textIsEmpty && pendingImages.length === 0);
    elements.clearButton.disabled = isSending;
    if (elements.imageCounter) {
      elements.imageCounter.textContent = `${pendingImages.length} of ${MAX_IMAGES} pictures attached`;
    }
  }

  function resizeInput() {
    elements.input.style.height = "auto";
    elements.input.style.height = `${Math.min(elements.input.scrollHeight, 144)}px`;
    updateControls();
  }

  function scrollToLatest() {
    window.requestAnimationFrame(() => {
      elements.messages.scrollTop = elements.messages.scrollHeight;
    });
  }

  function createMessageElement(role, content, isError = false) {
    const article = document.createElement("article");
    article.className = `message message-${role}${isError ? " message-error" : ""}`;

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = role === "user" ? "Y" : "B";

    const column = document.createElement("div");
    column.className = "message-column";

    const meta = document.createElement("div");
    meta.className = "message-meta";
    const name = document.createElement("span");
    name.textContent = role === "user" ? currentUsername || "You" : "BOOT Chat";
    const time = document.createElement("time");
    time.dateTime = new Date().toISOString();
    time.textContent = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date());
    meta.append(name, time);

    column.append(meta);

    if (typeof content === "string") {
      const text = document.createElement("div");
      text.className = "message-content";
      text.textContent = content;
      column.append(text);
    } else {
      const textParts = content.filter((part) => part.type === "text");
      const images = content.filter((part) => part.type === "image_url");
      const text = textParts.map((part) => part.text).join("\n").trim();

      if (text) {
        const textElement = document.createElement("div");
        textElement.className = "message-content";
        textElement.textContent = text;
        column.append(textElement);
      }

      if (images.length > 0) {
        const imageGrid = document.createElement("div");
        imageGrid.className = "message-images";
        images.forEach((part) => {
          const image = document.createElement("img");
          image.src = part.image_url.url;
          image.alt = "Picture sent with this message";
          image.loading = "lazy";
          imageGrid.append(image);
        });
        column.append(imageGrid);
      }
    }

    article.append(avatar, column);
    return article;
  }

  function renderMessage(role, content, isError = false) {
    const nearBottom = elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 120;
    const message = createMessageElement(role, content, isError);
    elements.messages.append(message);
    if (nearBottom || isError) {
      scrollToLatest();
    }
  }

  function renderWelcome() {
    const greeting = currentUsername ? `Hi ${currentUsername}! I’m BOOT Chat.` : "Hi! I’m BOOT Chat.";
    const welcome = createMessageElement(
      "assistant",
      `${greeting} Send a message, attach up to three pictures, or do both. I can describe images, read visible text, compare pictures, and help with questions.`
    );
    elements.messages.replaceChildren(welcome);
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
        setStatus(pendingImages.length > 0 ? `${pendingImages.length} picture${pendingImages.length === 1 ? "" : "s"} ready` : "Ready");
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

    const accepted = files.filter((file) => ALLOWED_IMAGE_TYPES.has(file.type) && file.size > 0);
    const rejectedCount = files.length - accepted.length;
    const availableSlots = MAX_IMAGES - pendingImages.length;
    const selected = accepted.slice(0, availableSlots);
    const skippedCount = rejectedCount + Math.max(0, accepted.length - selected.length);

    if (selected.length === 0) {
      setStatus(
        rejectedCount > 0 ? "Attach JPG, PNG or WebP pictures only" : "You can attach up to 3 pictures",
        "error"
      );
      return;
    }

    const currentBytes = pendingImages.reduce((total, image) => total + image.size, 0);
    const allowed = [];
    let addedBytes = 0;
    let sizeRejectedCount = 0;

    selected.forEach((file) => {
      if (currentBytes + addedBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
        sizeRejectedCount += 1;
        return;
      }
      addedBytes += file.size;
      allowed.push(file);
    });

    if (allowed.length === 0) {
      setStatus("Pictures must be 2.5 MB or less in total", "error");
      return;
    }

    isReadingImages = true;
    updateControls();
    setStatus("Preparing pictures...");

    try {
      const prepared = await Promise.all(
        allowed.map(async (file) => ({
          id: createId(),
          name: file.name || "picture",
          size: file.size,
          type: file.type,
          dataUrl: await readFileAsDataUrl(file)
        }))
      );
      pendingImages.push(...prepared);
      renderAttachments();
      const rejectedSummary = skippedCount + sizeRejectedCount;
      setStatus(
        rejectedSummary > 0
          ? `${pendingImages.length} picture${pendingImages.length === 1 ? "" : "s"} ready · ${rejectedSummary} skipped`
          : `${pendingImages.length} picture${pendingImages.length === 1 ? "" : "s"} ready`,
        rejectedSummary > 0 ? "error" : ""
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not read that picture", "error");
    } finally {
      isReadingImages = false;
      elements.imageInput.value = "";
      updateControls();
    }
  }

  function buildApiMessages() {
    return conversation.slice(-MAX_HISTORY_MESSAGES).map((message, index, messages) => {
      if (typeof message.content === "string") {
        return { role: message.role, content: message.content };
      }

      const isLatest = index === messages.length - 1;
      const content = message.content
        .map((part) => {
          if (part.type === "image_url" && !isLatest) {
            return { type: "text", text: "[A picture was attached in an earlier message.]" };
          }
          return part;
        })
        .filter(Boolean);
      return { role: message.role, content };
    });
  }

  function getRequestError(error) {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return "BOOT couldn’t reach the API. Check your connection and try again.";
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!currentUsername) {
      showLogin();
      return;
    }
    if (isSending || isReadingImages || isComposingRequest) {
      return;
    }

    const text = elements.input.value.trim();
    if (!text && pendingImages.length === 0) {
      return;
    }

    isComposingRequest = true;

    const content = [];
    if (text) {
      content.push({ type: "text", text });
    }
    pendingImages.forEach((image) => {
      content.push({
        type: "image_url",
        image_url: {
          url: image.dataUrl,
          detail: "auto"
        }
      });
    });

    const userContent = text && content.length === 1 ? text : content;
    conversation.push({ role: "user", content: userContent });
    renderMessage("user", userContent);
    elements.input.value = "";
    pendingImages = [];
    renderAttachments();
    resizeInput();
    setSending(true);
    setStatus("BOOT is thinking...");

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    isComposingResponse = true;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: currentUsername, messages: buildApiMessages() }),
        signal: controller.signal
      });

      let data = {};
      try {
        data = await response.json();
    } catch {
      data = {};
    }

      if (!response.ok) {
        throw new Error(data.error || "The API could not complete that request. Please try again.");
      }
      if (typeof data.reply !== "string" || !data.reply.trim()) {
        throw new Error("The API returned an empty response. Please try again.");
      }

      const reply = data.reply.trim();
      conversation.push({ role: "assistant", content: reply });
      isComposingResponse = false;
      setSending(false);
      renderMessage("assistant", reply);
      setStatus("Connected", "success");
    } catch (error) {
      const message = error && error.name === "AbortError"
        ? "BOOT took too long to respond. Please try again."
        : getRequestError(error);
      isComposingResponse = false;
      setSending(false);
      renderMessage("assistant", message, true);
      setStatus("Connection error · Try again", "error");
    } finally {
      window.clearTimeout(timeout);
      isComposingRequest = false;
      isComposingResponse = false;
      setSending(false);
      elements.input.focus();
    }
  }

  function clearConversation() {
    if (isSending) {
      return;
    }
    if (conversation.length > 0 && !window.confirm("Start a new BOOT Chat conversation?")) {
      return;
    }
    conversation = [];
    pendingImages = [];
    elements.input.value = "";
    renderAttachments();
    renderWelcome();
    resizeInput();
    setStatus("Ready");
    elements.input.focus();
  }

  function hasDraggedFiles(event) {
    return Array.from(event.dataTransfer && event.dataTransfer.types ? event.dataTransfer.types : []).includes("Files");
  }

  elements.form.addEventListener("submit", sendMessage);
  elements.clearButton.addEventListener("click", clearConversation);
  elements.input.addEventListener("input", resizeInput);

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
    if (conversation.length > 0 && !window.confirm("Change username and clear this chat?")) {
      return;
    }
    exitChat();
  });
  elements.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      elements.form.requestSubmit();
    }
  });

  elements.attachButton.addEventListener("click", () => elements.imageInput.click());
  elements.imageInput.addEventListener("change", () => addFiles(elements.imageInput.files));

  elements.input.addEventListener("paste", (event) => {
    const clipboard = event.clipboardData;
    if (!clipboard) {
      return;
    }
    const files = Array.from(clipboard.files);
    const images = files.filter((file) => ALLOWED_IMAGE_TYPES.has(file.type) && file.size > 0);
    if (images.length === 0) {
      return;
    }
    event.preventDefault();
    const pastedText = String(clipboard.getData("text/plain") || "").trim();
    if (pastedText) {
      const current = elements.input.value;
      const next = `${current}${current ? " " : ""}${pastedText}`.slice(0, 8000);
      elements.input.value = next;
      resizeInput();
    }
    addFiles(files);
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

  const storedUsername = getStoredUsername();
  const storedResult = validateUsername(storedUsername);
  if (storedResult.ok) {
    currentUsername = storedResult.name;
    showChat();
    renderWelcome();
    resizeInput();
  } else {
    showLogin();
    elements.usernameInput.focus();
  }
})();
