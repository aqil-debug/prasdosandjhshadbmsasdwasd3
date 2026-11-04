"use strict";

// EASY SETTINGS: edit these values, save, and refresh the page.
const SETTINGS = {
  walkingSpeed: 42, // Pixels per second. Higher = faster. Use 0 to stand still.
  grassLevel: 78, // Percentage from the top of the background to Garfield's feet.
  dropGravity: 1800, // Downward acceleration when released. Higher = a faster drop.
  // Character size: change --character-size near the top of style.css.

  // OPTIONAL: transparent PNG/WebP frames, all facing RIGHT, in walking order.
  // Leave empty to use the animated, layered SVG that works out of the box.
  // Example: ["./assets/walk-01.png", "./assets/walk-02.png", ...]
  spriteFrames: [],
  spriteFrameDuration: 110 // Milliseconds per frame, when custom frames are used.
};

const world = document.getElementById("world");
const background = document.getElementById("background");
const garfield = document.getElementById("garfield");
const facing = document.getElementById("characterFacing");
const dialogue = document.getElementById("dialogue");
const dialogueTitle = document.getElementById("dialogueTitle");
const messageText = document.getElementById("messageText");
const messageScroll = document.getElementById("messageScroll");
const counter = document.getElementById("messageCounter");
const previousButton = document.getElementById("previousMessage");
const nextButton = document.getElementById("nextMessage");
const closeButton = document.getElementById("closeDialogue");
const spriteContainer = document.getElementById("spriteFrames");
const catShadow = garfield.querySelector(".cat-shadow");
const sceneToggle = document.getElementById("sceneToggle");
const sceneNote = document.querySelector(".scene-note");
const initialCaption = sceneNote.textContent;
const completedCaption = "'We're always there for you' - Your found family, bozos";

// Each illustration places the walking surface 78% down the image.
const SCENES = {
  garden: { name: "Sunny garden", image: "./assets/background.png" },
  city: { name: "City streets", image: "./assets/city.svg" },
  farm: { name: "Farmhouse", image: "./assets/farm.svg" },
  moon: { name: "On the moon", image: "./assets/moon.svg" },
  srilanka: { name: "Rural Sri Lanka", image: "./assets/sri-lanka.svg" }
};

const sceneOrder = Object.keys(SCENES); // Garden → city → farm → moon → Sri Lanka → garden.

function selectScene(key) {
  const scene = SCENES[key];
  if (!scene) return;
  world.dataset.scene = key;
  world.setAttribute("aria-label", `Garfield: ${scene.name}`);
  background.src = scene.image;
  const nextKey = sceneOrder[(sceneOrder.indexOf(key) + 1) % sceneOrder.length];
  sceneToggle.setAttribute("aria-label", `Change scene to ${SCENES[nextKey].name}. Current scene: ${scene.name}`);
  sceneToggle.title = `Next: ${SCENES[nextKey].name}`;
  try { localStorage.setItem("garfield-scene", key); } catch { /* Storage is optional. */ }
}

sceneToggle.addEventListener("click", () => {
  const nextIndex = (sceneOrder.indexOf(world.dataset.scene) + 1) % sceneOrder.length;
  selectScene(sceneOrder[nextIndex]);
});

let initialScene = "garden";
try { initialScene = localStorage.getItem("garfield-scene") || "garden"; } catch { /* Use the garden. */ }
selectScene(SCENES[initialScene] ? initialScene : "garden");

const defaultAuthor = "Garfield";
const quietThought = { author: defaultAuthor, text: "Nothing on my mind right now. Just enjoying the sunshine." };
let messages = [{ author: defaultAuthor, text: "Just gathering my thoughts…" }];
let messageIndex = 0;
let hasLoadedMessages = false;
const readMessageIndices = new Set(); // Count each displayed note once per visit.
let x = 0;
let direction = 1;
let minX = 6;
let maxX = 6;
let lift = 0; // Height above the grass. Never negative, even during a drag.
let maxLift = 0;
let falling = false;
let fallVelocity = 0;
let drag = null;
let suppressPointerClick = false;
let hasMeasured = false;
let lastTime = null;
let animationId = null;
let spriteImages = [];
let spriteIndex = 0;
let spriteElapsed = 0;
let swipeStart = null;

world.style.setProperty("--grass-level", `${SETTINGS.grassLevel}%`);
// Make the footstep rhythm follow the selected walking speed.
world.style.setProperty("--step-duration", `${Math.max(0.25, Math.min(2, 0.72 * 42 / (SETTINGS.walkingSpeed || 42)))}s`);

function drawPosition() {
  garfield.style.transform = `translate3d(${x}px, ${-lift}px, 0)`;
  facing.style.transform = `scaleX(${direction})`;
  garfield.dataset.direction = direction === 1 ? "right" : "left";
  // Keep the shadow on the grass while Garfield is held in the air.
  catShadow.style.transform = `translateY(${lift}px) scale(${Math.max(0.45, 1 - lift / 1000)})`;
  catShadow.style.opacity = Math.max(0.2, 1 - lift / 600);
}

function measureScene() {
  const oldRange = maxX - minX;
  const progress = hasMeasured && oldRange > 0 ? (x - minX) / oldRange : 0.12;
  maxX = Math.max(minX, world.clientWidth - garfield.offsetWidth - minX);
  maxLift = Math.max(0, world.clientHeight * SETTINGS.grassLevel / 100 - garfield.offsetHeight - 6);
  x = minX + Math.max(0, Math.min(1, progress)) * (maxX - minX);
  lift = Math.max(0, Math.min(lift, maxLift));
  hasMeasured = true;
  // A changed viewport ends an active grab rather than leaving a stale offset.
  if (drag) finishDrag();
  else if (falling && lift === 0) {
    falling = false;
    fallVelocity = 0;
    syncWalking();
  }
  drawPosition();
}

background.addEventListener("error", () => { background.hidden = true; });
background.addEventListener("load", () => { background.hidden = false; });
// A bundled SVG garden handles a missing PNG.
if (background.complete && !background.naturalWidth) background.hidden = true;

// A ResizeObserver keeps the path and feet aligned after resize or rotation.
const sceneObserver = new ResizeObserver(measureScene);
sceneObserver.observe(world);
sceneObserver.observe(garfield);
measureScene();

function advanceSprite(seconds) {
  if (spriteImages.length < 2) return;
  spriteElapsed += seconds * 1000;
  const frameDuration = Math.max(16, SETTINGS.spriteFrameDuration);
  if (spriteElapsed < frameDuration) return;
  spriteImages[spriteIndex].classList.remove("is-current");
  spriteIndex = (spriteIndex + Math.floor(spriteElapsed / frameDuration)) % spriteImages.length;
  spriteElapsed %= frameDuration;
  spriteImages[spriteIndex].classList.add("is-current");
}

function animateScene(time) {
  animationId = null;
  if (dialogue.open || document.hidden || drag || (!falling && SETTINGS.walkingSpeed <= 0)) return;
  // Use elapsed time for the same speed on 60 Hz and 120 Hz screens.
  // Cap long gaps so returning to a background tab never teleports the cat.
  const seconds = lastTime === null ? 0 : Math.min((time - lastTime) / 1000, 0.05);
  lastTime = time;
  if (falling) {
    fallVelocity += SETTINGS.dropGravity * seconds;
    lift = Math.max(0, lift - fallVelocity * seconds);
    if (lift === 0) {
      falling = false;
      fallVelocity = 0;
      drawPosition();
      syncWalking();
      return;
    }
  } else {
    x += direction * SETTINGS.walkingSpeed * seconds;
    if (x >= maxX) {
      x = Math.max(minX, maxX - (x - maxX));
      direction = -1;
    } else if (x <= minX) {
      x = Math.min(maxX, minX + (minX - x));
      direction = 1;
    }
    advanceSprite(seconds);
  }
  drawPosition();
  animationId = requestAnimationFrame(animateScene);
}

function syncWalking() {
  const canMove = !dialogue.open && !document.hidden && !drag;
  const shouldWalk = canMove && !falling && SETTINGS.walkingSpeed > 0;
  garfield.classList.toggle("is-walking", shouldWalk);
  garfield.classList.toggle("is-falling", falling);
  if (animationId !== null) cancelAnimationFrame(animationId);
  animationId = null;
  lastTime = null;
  if (canMove && (shouldWalk || falling)) animationId = requestAnimationFrame(animateScene);
}

// Pointer events cover mouse, touch, and pen. A small threshold preserves taps.
garfield.addEventListener("pointerdown", event => {
  if (!event.isPrimary || event.button !== 0 || drag || dialogue.open) return;
  event.preventDefault(); // Keep native image dragging and text selection out of the gesture.
  garfield.classList.add("is-pointer-focused");
  garfield.focus({ preventScroll: true });
  const bounds = garfield.getBoundingClientRect();
  suppressPointerClick = false;
  drag = {
    id: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: event.clientX - bounds.left,
    offsetY: event.clientY - bounds.top,
    moved: false
  };
  garfield.setPointerCapture(event.pointerId);
  syncWalking();
});

garfield.addEventListener("pointermove", event => {
  if (!drag || event.pointerId !== drag.id) return;
  // Recover if a mouse release happened outside the browser window.
  if (event.pointerType === "mouse" && event.buttons === 0) {
    finishDrag(event);
    return;
  }
  if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 7) return;
  drag.moved = true;
  falling = false;
  fallVelocity = 0;
  garfield.classList.add("is-dragging");
  garfield.classList.remove("is-falling");
  event.preventDefault();

  const bounds = world.getBoundingClientRect();
  x = Math.max(minX, Math.min(maxX, event.clientX - bounds.left - drag.offsetX));
  const desiredFeet = event.clientY - bounds.top - drag.offsetY + garfield.offsetHeight;
  const groundY = world.clientHeight * SETTINGS.grassLevel / 100;
  // Clamp at the grass and top of the screen; Garfield cannot go underground.
  lift = Math.max(0, Math.min(maxLift, groundY - desiredFeet));
  drawPosition();
});

function finishDrag(event) {
  if (!drag || (event && event.pointerId !== drag.id)) return;
  const finished = drag;
  drag = null;
  suppressPointerClick = finished.moved;
  garfield.classList.remove("is-dragging");
  if (garfield.hasPointerCapture(finished.id)) garfield.releasePointerCapture(finished.id);
  falling = lift > 0;
  fallVelocity = 0;
  syncWalking();
}

garfield.addEventListener("pointerup", finishDrag);
garfield.addEventListener("pointercancel", finishDrag);
garfield.addEventListener("lostpointercapture", finishDrag);
garfield.addEventListener("dragstart", event => event.preventDefault());
garfield.addEventListener("contextmenu", event => { if (drag) event.preventDefault(); });
window.addEventListener("blur", () => finishDrag());
// Restore the keyboard focus ring when the player switches back to the keyboard.
document.addEventListener("keydown", () => garfield.classList.remove("is-pointer-focused"));

// Each line can be "Name | Message". Old message-only lines still work.
function parseMessageLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf("|");
  const author = separator === -1 ? defaultAuthor : trimmed.slice(0, separator).trim() || defaultAuthor;
  const text = separator === -1 ? trimmed : trimmed.slice(separator + 1).trim();
  return text ? { author, text } : null;
}

async function loadMessages() {
  hasLoadedMessages = false;
  readMessageIndices.clear();
  sceneNote.textContent = initialCaption;
  try {
    // Browsers block reading neighboring files when index.html is double-clicked.
    if (window.location.protocol === "file:") throw new Error("Local file mode");
    // no-store asks the browser for the edited file on each page refresh.
    const response = await fetch("./messages.txt", { cache: "no-store" });
    if (!response.ok) throw new Error("Messages unavailable");
    const text = await response.text();
    const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/).map(parseMessageLine).filter(Boolean);
    messages = lines.length ? lines : [quietThought];
    hasLoadedMessages = lines.length > 0;
  } catch {
    // Explain local file restrictions instead of silently hiding the user's notes.
    messages = window.location.protocol === "file:"
      ? [{ author: defaultAuthor, text: "Your notes are saved, but this browser cannot read them when index.html is opened directly. Close this tab and double-click start-game.bat in the game folder. Keep its window open, then tap Garfield in the browser page it opens." }]
      : [quietThought];
  }
  messageIndex %= messages.length;
  if (dialogue.open) renderMessage();
}

function rememberDisplayedMessage() {
  // Loading text and fallback messages must not unlock the surprise.
  if (!hasLoadedMessages || !dialogue.open) return;
  readMessageIndices.add(messageIndex);
  if (readMessageIndices.size === messages.length) sceneNote.textContent = completedCaption;
}

function renderMessage() {
  // textContent displays Notepad text safely, even if a line contains HTML.
  const message = messages[messageIndex];
  dialogueTitle.textContent = `${message.author} says…`;
  messageText.textContent = message.text;
  messageScroll.setAttribute("aria-label", `${message.author}'s message. Swipe left or right to change notes.`);
  counter.textContent = `${messageIndex + 1} / ${messages.length}`;
  counter.setAttribute("aria-label", `Message ${messageIndex + 1} of ${messages.length}`);
  previousButton.disabled = messages.length < 2;
  nextButton.disabled = messages.length < 2;
  messageScroll.scrollTop = 0;
  rememberDisplayedMessage();
}

function changeMessage(step) {
  messageIndex = (messageIndex + step + messages.length) % messages.length;
  renderMessage();
}

function openDialogue() {
  if (dialogue.open || drag) return;
  renderMessage();
  dialogue.showModal();
  rememberDisplayedMessage();
  garfield.setAttribute("aria-expanded", "true");
  syncWalking();
}

function closeDialogue() {
  if (dialogue.open) dialogue.close();
}

garfield.addEventListener("click", event => {
  // Ignore the click generated after a drag; keyboard activation still works.
  if (suppressPointerClick && event.detail !== 0) {
    suppressPointerClick = false;
    event.preventDefault();
    return;
  }
  openDialogue();
});
closeButton.addEventListener("click", closeDialogue);
previousButton.addEventListener("click", () => changeMessage(-1));
nextButton.addEventListener("click", () => changeMessage(1));
dialogue.addEventListener("close", () => {
  swipeStart = null;
  garfield.setAttribute("aria-expanded", "false");
  syncWalking();
});

// Native <dialog> handles Escape, focus trapping, and returning keyboard focus.
dialogue.addEventListener("click", event => {
  if (event.target !== dialogue) return;
  const bounds = dialogue.getBoundingClientRect();
  const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  if (outside) closeDialogue();
});
dialogue.addEventListener("keydown", event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    changeMessage(event.key === "ArrowRight" ? 1 : -1);
  }
});

// Horizontal swipes change thoughts; vertical gestures keep long text scrollable.
messageScroll.addEventListener("pointerdown", event => {
  if (event.pointerType === "mouse") return;
  swipeStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
});
messageScroll.addEventListener("pointerup", event => {
  if (!swipeStart || event.pointerId !== swipeStart.id) return;
  const dx = event.clientX - swipeStart.x;
  const dy = event.clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy) * 1.25) changeMessage(dx < 0 ? 1 : -1);
});
messageScroll.addEventListener("pointercancel", () => { swipeStart = null; });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) finishDrag();
  syncWalking();
});

async function loadCustomSprites() {
  // A single still image is deliberately not treated as a walking animation.
  if (SETTINGS.spriteFrames.length < 2) return;
  const candidates = SETTINGS.spriteFrames.map(source => {
    const frame = new Image();
    frame.alt = "";
    frame.className = "sprite-frame";
    frame.draggable = false;
    return { frame, source };
  });
  try {
    await Promise.all(candidates.map(({ frame, source }) => new Promise((resolve, reject) => {
      frame.onload = resolve;
      frame.onerror = reject;
      frame.src = source;
    })));
    spriteImages = candidates.map(({ frame }) => frame);
    spriteContainer.replaceChildren(...spriteImages);
    spriteImages[0].classList.add("is-current");
    garfield.classList.add("has-sprites");
  } catch {
    // Keep the complete SVG walk if any custom frame cannot load.
    console.info("A walking frame could not load. Using the built-in animated cat.");
  }
}

loadMessages();
loadCustomSprites();
syncWalking();
