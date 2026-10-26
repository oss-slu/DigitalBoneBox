// boneset-api/scenes.js
// Scene Editor Workspace API (big rock #420).
const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const { buildLegacyImages, isValidBoneId, LegacyImportError } = require("./legacyImport");
const { buildLegacyAnnotations } = require("./legacyAnnotations");

const MAX_IMPORT_LOG_ENTRIES = 50;
const MAX_LOGGED_WARNINGS = 100;

const DEFAULT_SCENE_NAME = "Untitled Scene";
const MAX_SCENE_NAME_LENGTH = 100;
const SCENE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 2MB raw file * ~4/3 base64 overhead, rounded down slightly for headroom under
// the express.json() body limit once the surrounding JSON is added (Issue #412).
const MAX_IMAGE_SRC_LENGTH = 2_800_000;
// Vercel caps request/response bodies at 4.5MB. A single image can pass the
// per-image cap above yet still combine with others to blow past that (PR #493
// review: two 2MB images ~ 5.6MB of base64). This bounds the sum of every
// image's `src` on one scene, leaving headroom for the rest of the JSON
// (ids/positions/annotations/timestamps are tiny next to base64 image data).
const MAX_SCENE_IMAGES_TOTAL_LENGTH = 3_800_000;
const SAFE_IMAGE_SRC_PREFIX = /^data:image\//i;
// What a saved scene image may point at: a same-origin path (e.g. a bone image
// at /api/images/...), a web URL, or embedded image data. blob: URLs only live
// as long as the page that made them, and script URLs must never be stored.
const PERSISTABLE_IMAGE_SRC = /^(\/(?!\/)|\.\/|https?:\/\/|data:image\/)/i;
const MAX_SCENE_OBJECTS = 1000;

class SceneStorageUnavailableError extends Error {}
class SceneLockTimeoutError extends Error {}

/**
 * Serializes concurrent operations that share the same key. Used to fix a
 * lost-update race (PR #493 review): PATCH does read-the-whole-scene then
 * write-the-whole-scene-back, so a rename and an image save racing each other
 * would otherwise silently clobber one another depending on which wrote last.
 */
function createKeyedMutex() {
    const tails = new Map();
    return function withLock(key, fn) {
        const tail = tails.get(key) || Promise.resolve();
        const run = tail.then(fn, fn);
        tails.set(key, run.catch(() => {}));
        return run;
    };
}

function isValidSceneId(sceneId) {
    return typeof sceneId === "string" && SCENE_ID_PATTERN.test(sceneId);
}

function normalizeSceneName(name) {
    if (typeof name !== "string") {
        return { error: "Scene name must be a string" };
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
        return { error: "Scene name cannot be empty" };
    }
    if (trimmed.length > MAX_SCENE_NAME_LENGTH) {
        return { error: `Scene name cannot exceed ${MAX_SCENE_NAME_LENGTH} characters` };
    }
    return { name: trimmed };
}

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validates an image object submitted for persistence via PATCH (Issue #412).
 * The `id` reuses the same UUID shape as scene ids (isValidSceneId) since both
 * are just crypto.randomUUID() values identifying different kinds of records.
 * @param {object} image
 * @returns {{ error: string } | { image: object }}
 */
function normalizeImage(image) {
    if (!image || typeof image !== "object") {
        return { error: "image must be an object" };
    }
    if (!isValidSceneId(image.id)) {
        return { error: "image.id must be a valid id" };
    }
    if (typeof image.src !== "string" || !SAFE_IMAGE_SRC_PREFIX.test(image.src)) {
        return { error: "image.src must be a data:image/ URL" };
    }
    if (image.src.length > MAX_IMAGE_SRC_LENGTH) {
        return { error: "Image is too large (max 2MB)" };
    }
    if (![image.x, image.y, image.width, image.height].every(isFiniteNumber)) {
        return { error: "image.x, image.y, image.width, and image.height must be numbers" };
    }
    if (image.width <= 0 || image.height <= 0) {
        return { error: "image.width and image.height must be greater than 0" };
    }

    return {
        image: { id: image.id, src: image.src, x: image.x, y: image.y, width: image.width, height: image.height },
    };
}

const UPDATABLE_IMAGE_FIELDS = [
    "x", "y", "width", "height", "rotation", "flipX", "flipY", "cropX", "cropY", "cropWidth", "cropHeight",
];
const CROP_FIELDS = ["cropX", "cropY", "cropWidth", "cropHeight"];

/**
 * Validates and applies a partial update to an already-saved image (Issues
 * #413-417: position, resize, rotate, flip, crop). Only the keys present in
 * `fields` are touched - everything else on `existingImage` (including `id`
 * and `src`, which this never accepts) carries over unchanged. Validation
 * runs against the *merged* result, not the raw patch in isolation, because
 * some constraints (the crop rect fitting within width/height) depend on the
 * final value of a field that might be changing in the very same request.
 * @param {object} existingImage
 * @param {object} fields
 * @returns {{ error: string } | { image: object }}
 */
function applyImagePatch(existingImage, fields) {
    if (!fields || typeof fields !== "object") {
        return { error: "fields must be an object" };
    }
    const unknownField = Object.keys(fields).find((key) => !UPDATABLE_IMAGE_FIELDS.includes(key));
    if (unknownField) {
        return { error: `Unknown image field: ${unknownField}` };
    }

    const merged = { ...existingImage, ...fields };

    if (![merged.x, merged.y, merged.width, merged.height].every(isFiniteNumber)) {
        return { error: "x, y, width, and height must be numbers" };
    }
    if (merged.width <= 0 || merged.height <= 0) {
        return { error: "width and height must be greater than 0" };
    }
    if (merged.rotation !== undefined && !isFiniteNumber(merged.rotation)) {
        return { error: "rotation must be a number" };
    }
    if (merged.flipX !== undefined && typeof merged.flipX !== "boolean") {
        return { error: "flipX must be a boolean" };
    }
    if (merged.flipY !== undefined && typeof merged.flipY !== "boolean") {
        return { error: "flipY must be a boolean" };
    }

    const hasCropField = CROP_FIELDS.some((key) => merged[key] !== undefined);
    if (hasCropField) {
        if (!CROP_FIELDS.every((key) => isFiniteNumber(merged[key]))) {
            return { error: "cropX, cropY, cropWidth, and cropHeight must all be numbers when cropping" };
        }
        if (merged.cropWidth <= 0 || merged.cropHeight <= 0) {
            return { error: "cropWidth and cropHeight must be greater than 0" };
        }
        if (
            merged.cropX < 0 || merged.cropY < 0 ||
            merged.cropX + merged.cropWidth > merged.width ||
            merged.cropY + merged.cropHeight > merged.height
        ) {
            return { error: "The crop area must fit within the image" };
        }
    }

    return { image: merged };
}

// The bone viewer items a scene's images were imported from (Issue #469), so the
// viewer can link an item to the scenes made from it.
function legacySources(scene) {
    const boneIds = (scene.images || [])
        .filter((image) => image && image.source && image.source.type === "legacy-image")
        .map((image) => image.source.boneId)
        .filter((boneId) => typeof boneId === "string");
    return [...new Set(boneIds)];
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates the content of a full-scene save (Issues #451, #452): `images`,
 * `annotations`, and optionally `importLog` (the record of bone imports, Issue
 * #467). Known image fields are type-checked with the same rules as
 * applyImagePatch; unknown fields on images and annotations (e.g. an imported
 * image's `source`, or an annotation's `sourceImageId`) are kept as-is.
 * @param {object} body
 * @param {{ requireArrays?: boolean }} [options] when false, missing arrays
 *   default to empty (creating a scene); when true both must be sent (saving).
 * @returns {{ error: string } | { images: object[], annotations: object[], importLog?: object[] }}
 */
function validateSceneContent(body, { requireArrays = true } = {}) {
    const images = body.images === undefined && !requireArrays ? [] : body.images;
    const annotations = body.annotations === undefined && !requireArrays ? [] : body.annotations;
    if (!Array.isArray(images) || !Array.isArray(annotations)) {
        return { error: "images and annotations must both be arrays" };
    }
    if (images.length > MAX_SCENE_OBJECTS || annotations.length > MAX_SCENE_OBJECTS) {
        return { error: `A scene can have at most ${MAX_SCENE_OBJECTS} images and ${MAX_SCENE_OBJECTS} annotations` };
    }

    let totalSrcLength = 0;
    for (const [index, image] of images.entries()) {
        if (!isPlainObject(image)) {
            return { error: `images[${index}] must be an object` };
        }
        if (typeof image.src !== "string" || !PERSISTABLE_IMAGE_SRC.test(image.src)) {
            return { error: `images[${index}].src is not an image source that can be saved` };
        }
        if (image.src.length > MAX_IMAGE_SRC_LENGTH) {
            return { error: `images[${index}] is too large (max 2MB)` };
        }
        const result = applyImagePatch(image, {});
        if (result.error) {
            return { error: `images[${index}]: ${result.error}` };
        }
        totalSrcLength += image.src.length;
    }
    if (totalSrcLength > MAX_SCENE_IMAGES_TOTAL_LENGTH) {
        return { error: "This scene is over its total image size limit; remove an image and try again" };
    }

    const badAnnotation = annotations.findIndex((annotation) => !isPlainObject(annotation));
    if (badAnnotation !== -1) {
        return { error: `annotations[${badAnnotation}] must be an object` };
    }

    const content = { images, annotations };
    if (body.importLog !== undefined) {
        const log = body.importLog;
        if (!Array.isArray(log) || log.length > MAX_SCENE_OBJECTS || !log.every(isPlainObject)) {
            return { error: "importLog must be a list of import records" };
        }
        content.importLog = log.slice(-MAX_IMPORT_LOG_ENTRIES);
    }
    return content;
}

// Strictly increasing per scene, so two writes in the same millisecond still
// get different versions for the PUT `baseUpdatedAt` check.
function nextUpdatedAt(previous) {
    const now = Date.now();
    const previousMs = Date.parse(previous);
    return new Date(Number.isFinite(previousMs) && previousMs >= now ? previousMs + 1 : now).toISOString();
}

// Issues #458/#459: a scene is a draft (unfinished, only shown in the Scene
// Editor) until someone publishes it for the general bone viewer.
const SCENE_STATUSES = ["draft", "published"];

/**
 * A scene's publication status. Scenes saved before statuses existed count as
 * drafts, so nothing unfinished is ever shown as final content by accident.
 * @param {object} scene
 * @returns {"draft"|"published"}
 */
function sceneStatus(scene) {
    return scene && scene.status === "published" ? "published" : "draft";
}

function toSummary(scene) {
    return {
        id: scene.id,
        name: scene.name,
        status: sceneStatus(scene),
        publishedAt: sceneStatus(scene) === "published" ? scene.publishedAt || null : null,
        imageCount: (scene.images || []).length,
        annotationCount: (scene.annotations || []).length,
        sources: legacySources(scene),
        createdAt: scene.createdAt,
        updatedAt: scene.updatedAt,
    };
}

// Local development only: one JSON file per scene.
function createFileSceneStore(scenesDir = path.join(__dirname, "data", "scenes")) {
    // Not tainted by user input - just the configured base directory, resolved
    // once so every function below checks containment against the same value.
    const resolvedScenesDir = path.resolve(scenesDir);

    async function ensureDir() {
        await fs.mkdir(scenesDir, { recursive: true });
    }

    // CodeQL (js/path-injection) flagged fs calls fed by a sceneId-derived path
    // even though the route layer already validates it: a sanitizer defined in
    // a separate helper function wasn't recognized as covering a different
    // function's fs call. So this check is duplicated inline in get/save/remove
    // below - right next to the fs call it guards, with nothing delegated - and
    // combines two independent proofs of safety on the exact value passed to
    // fs: (1) sceneId can only be a bare UUID (no "/", "\", or ".." possible),
    // and (2) the resolved path is explicitly re-verified to still be inside
    // resolvedScenesDir before it's used, so even a hypothetical regex bypass
    // could not escape this directory.
    async function get(sceneId) {
        if (!isValidSceneId(sceneId)) {
            throw new Error("Invalid sceneId");
        }
        const target = path.resolve(resolvedScenesDir, `${sceneId}.json`);
        if (!target.startsWith(resolvedScenesDir + path.sep)) {
            throw new Error("Invalid sceneId");
        }
        try {
            const raw = await fs.readFile(target, "utf8");
            return JSON.parse(raw);
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
    }

    async function list() {
        await ensureDir();
        const files = (await fs.readdir(scenesDir)).filter((f) => f.endsWith(".json"));
        const scenes = [];
        for (const file of files) {
            const sceneId = path.basename(file, ".json");
            if (!isValidSceneId(sceneId)) continue;
            const scene = await get(sceneId);
            if (scene) scenes.push(scene);
        }
        return scenes;
    }

    async function save(scene) {
        if (!isValidSceneId(scene.id)) {
            throw new Error("Invalid sceneId");
        }
        const target = path.resolve(resolvedScenesDir, `${scene.id}.json`);
        if (!target.startsWith(resolvedScenesDir + path.sep)) {
            throw new Error("Invalid sceneId");
        }
        await ensureDir();
        const tmp = `${target}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(scene, null, 2), "utf8");
        await fs.rename(tmp, target);
        return scene;
    }

    async function remove(sceneId) {
        if (!isValidSceneId(sceneId)) {
            throw new Error("Invalid sceneId");
        }
        const target = path.resolve(resolvedScenesDir, `${sceneId}.json`);
        if (!target.startsWith(resolvedScenesDir + path.sep)) {
            throw new Error("Invalid sceneId");
        }
        try {
            await fs.unlink(target);
            return true;
        } catch (error) {
            if (error.code === "ENOENT") return false;
            throw error;
        }
    }

    return { list, get, save, remove, withLock: createKeyedMutex() };
}

// How long a write will wait for another write on the same scene before giving
// up (returns 423 "busy" rather than hanging indefinitely), and how long a
// held lock survives if its holder crashes before releasing it.
const SCENE_LOCK_WAIT_MS = 3000;
const SCENE_LOCK_POLL_MS = 50;
const SCENE_LOCK_TTL_MS = 5000;

// Releases a scene lock only if it still holds the caller's token, as one
// atomic step on the Redis server. A separate GET then DEL is not safe: the
// lock can expire between the two calls and be acquired by another request,
// and the DEL would then delete that request's lock. Returns 1 if this caller's
// lock was deleted, 0 if the lock had already expired or belongs to someone else.
const RELEASE_LOCK_SCRIPT =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

// Durable shared storage for deployments. Each scene is stored under its own key,
// and a set tracks every scene id so the list route doesn't need to scan keys.
function createRedisSceneStore(redis, prefix = "bonebox") {
    const indexKey = `${prefix}:scenes`;
    const sceneKey = (sceneId) => `${prefix}:scene:${sceneId}`;
    const lockKey = (sceneId) => `${prefix}:lock:${sceneId}`;

    async function get(sceneId) {
        return (await redis.get(sceneKey(sceneId))) || null;
    }

    async function list() {
        const ids = (await redis.smembers(indexKey)).filter(isValidSceneId);
        if (ids.length === 0) return [];
        const scenes = await redis.mget(...ids.map(sceneKey));
        return scenes.filter(Boolean);
    }

    async function save(scene) {
        await redis.set(sceneKey(scene.id), scene);
        await redis.sadd(indexKey, scene.id);
        return scene;
    }

    async function remove(sceneId) {
        const deleted = await redis.del(sceneKey(sceneId));
        await redis.srem(indexKey, sceneId);
        return deleted > 0;
    }

    /**
     * Acquires the distributed per-scene lock, waiting up to
     * SCENE_LOCK_WAIT_MS. The lock expires after SCENE_LOCK_TTL_MS so a holder
     * that crashes can't block the scene forever.
     * @param {string} sceneId
     * @returns {Promise<string>} the token that identifies this holder
     */
    async function acquireLock(sceneId) {
        const key = lockKey(sceneId);
        const token = crypto.randomUUID();
        const deadline = Date.now() + SCENE_LOCK_WAIT_MS;
        for (;;) {
            const acquired = await redis.set(key, token, { nx: true, px: SCENE_LOCK_TTL_MS });
            if (acquired) return token;
            if (Date.now() >= deadline) {
                throw new SceneLockTimeoutError("Scene is busy, try again");
            }
            await new Promise((resolve) => setTimeout(resolve, SCENE_LOCK_POLL_MS));
        }
    }

    /**
     * Releases the lock only if `token` still owns it (atomic compare-and-delete,
     * see RELEASE_LOCK_SCRIPT). If the lock expired and another request now
     * holds it, that request's lock is left alone.
     * @param {string} sceneId
     * @param {string} token
     * @returns {Promise<boolean>} true if this holder's lock was released
     */
    async function releaseLock(sceneId, token) {
        const deleted = await redis.eval(RELEASE_LOCK_SCRIPT, [lockKey(sceneId)], [token]);
        return Number(deleted) === 1;
    }

    /**
     * Runs `fn` while holding the per-scene lock (PR #493 review fix) so a
     * rename and an image save racing each other across serverless
     * invocations can't clobber one another the way two unserialized
     * read-modify-writes otherwise would.
     */
    async function withLock(sceneId, fn) {
        const token = await acquireLock(sceneId);
        try {
            return await fn();
        } finally {
            await releaseLock(sceneId, token);
        }
    }

    return { list, get, save, remove, withLock, acquireLock, releaseLock };
}

function createUnavailableSceneStore(reason) {
    const fail = async () => {
        throw new SceneStorageUnavailableError(reason);
    };
    return { list: fail, get: fail, save: fail, remove: fail, withLock: fail };
}

function hasRedisConfig(env) {
    return Boolean(
        (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) ||
        (env.KV_REST_API_URL && env.KV_REST_API_TOKEN)
    );
}

// Deployed functions have no durable filesystem, so without Redis configured the
// scene routes return 503 instead of saving scenes that would silently disappear.
function resolveSceneStore(env = process.env) {
    if (hasRedisConfig(env)) {
        const { Redis } = require("@upstash/redis");
        return createRedisSceneStore(Redis.fromEnv());
    }
    if (env.VERCEL) {
        console.error("Scene storage is not configured: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.");
        return createUnavailableSceneStore("Scene storage is not configured for this deployment");
    }
    return createFileSceneStore(env.SCENES_DIR ? path.resolve(env.SCENES_DIR) : undefined);
}

function isNameTaken(scenes, name, exceptId = null) {
    const lowered = name.toLowerCase();
    return scenes.some((s) => s.id !== exceptId && s.name.toLowerCase() === lowered);
}

function nextAvailableName(scenes, base) {
    if (!isNameTaken(scenes, base)) return base;
    let n = 2;
    while (isNameTaken(scenes, `${base} ${n}`)) n += 1;
    return `${base} ${n}`;
}

function nextDefaultName(scenes) {
    return nextAvailableName(scenes, DEFAULT_SCENE_NAME);
}

// "<name> copy", numbered if taken. The original name is shortened first so
// the result (including a number suffix) stays within the name length limit.
function nextCopyName(scenes, name) {
    const base = `${name.slice(0, MAX_SCENE_NAME_LENGTH - 10).trimEnd()} copy`;
    return nextAvailableName(scenes, base);
}

function sendStoreError(res, error, message) {
    if (error instanceof SceneStorageUnavailableError) {
        return res.status(503).json({ error: error.message });
    }
    // 423 rather than 409 so a busy scene can't be mistaken for a name conflict.
    if (error instanceof SceneLockTimeoutError) {
        return res.status(423).json({ error: error.message });
    }
    console.error(`${message}:`, error.message);
    return res.status(500).json({ error: message });
}

/**
 * @param {object} [store] scene storage (file, Redis, or unavailable)
 * @param {object} [options]
 * @param {object} [options.legacyContent] where existing bone content lives:
 *   { descriptionsDir, imagesDir }. Defaults to boneset-api/data.
 */
function createScenesRouter(store = resolveSceneStore(), options = {}) {
    const router = express.Router();

    router.use(rateLimit({
        windowMs: 60 * 1000,
        max: 100,
        standardHeaders: true,
        legacyHeaders: false,
    }));

    router.param("sceneId", (req, res, next, sceneId) => {
        if (!isValidSceneId(sceneId)) {
            return res.status(400).json({ error: "Invalid sceneId format" });
        }
        next();
    });

    /**
     * Lists all scenes (summaries only) for the scene picker. Issues #422, #423, #424.
     */
    router.get("/", async (req, res) => {
        const { status } = req.query;
        if (status !== undefined && !SCENE_STATUSES.includes(status)) {
            return res.status(400).json({ error: "status must be \"draft\" or \"published\"" });
        }
        try {
            let scenes = await store.list();
            if (status) scenes = scenes.filter((scene) => sceneStatus(scene) === status);
            scenes.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
            res.json({ scenes: scenes.map(toSummary) });
        } catch (error) {
            sendStoreError(res, error, "Failed to list scenes");
        }
    });

    /**
     * Creates a new scene with a unique id. Name is optional and defaults to
     * "Untitled Scene" (numbered if taken). Issues #421, #423. The scene starts
     * blank unless `images`, `annotations`, and `importLog` are sent, which lets
     * a working copy whose scene was deleted elsewhere be saved as a new scene
     * in one request, so a failure can't leave an empty scene behind (Issue #456).
     */
    router.post("/", async (req, res) => {
        try {
            const body = isPlainObject(req.body) ? req.body : {};
            const content = validateSceneContent(body, { requireArrays: false });
            if (content.error) {
                return res.status(400).json({ error: content.error });
            }
            const scenes = await store.list();
            let name;
            if (body.name !== undefined) {
                const result = normalizeSceneName(body.name);
                if (result.error) {
                    return res.status(400).json({ error: result.error });
                }
                if (isNameTaken(scenes, result.name)) {
                    return res.status(409).json({ error: `A scene named "${result.name}" already exists` });
                }
                name = result.name;
            } else {
                name = nextDefaultName(scenes);
            }

            const now = new Date().toISOString();
            const scene = {
                id: crypto.randomUUID(),
                name,
                images: content.images,
                annotations: content.annotations,
                ...(content.importLog ? { importLog: content.importLog } : {}),
                // New scenes always start unpublished (Issue #458).
                status: "draft",
                createdAt: now,
                updatedAt: now,
            };
            await store.save(scene);
            res.status(201).location(`${req.baseUrl}/${scene.id}`).json(scene);
        } catch (error) {
            sendStoreError(res, error, "Failed to create scene");
        }
    });

    /**
     * Returns a full scene (images and annotations) to open in the workspace. Issues #422, #425.
     */
    router.get("/:sceneId", async (req, res) => {
        try {
            const { sceneId } = req.params;
            if (!isValidSceneId(sceneId)) {
                return res.status(400).json({ error: "Invalid sceneId" });
            }

            const scene = await store.get(sceneId);
            if (!scene) {
                return res.status(404).json({ error: "Scene not found" });
            }
            res.json(scene);
        } catch (error) {
            sendStoreError(res, error, "Failed to load scene");
        }
    });

    /**
     * Updates a scene. Supports renaming (empty names rejected, duplicates return
     * 409 - Issue #423), adding one newly imported image (validated and upserted
     * by id so a retried request can't create a duplicate - Issue #412), updating
     * an existing image's position/size/rotation/flip/crop (`updateImage` - Issues
     * #413-417), removing one image by id (`removeImageId` - a no-op if already
     * gone, so a retry is always safe - Issue #418), and reordering images
     * (`reorderImageIds` - must be a permutation of the scene's current image ids
     * - Issue #419). At least one of these fields must be present in the body.
     * The whole read-modify-write
     * runs under a per-scene lock (PR #493 review) so concurrent updates (e.g. a
     * rename racing an image save) can't silently clobber one another - without
     * it, both would read the same snapshot and whichever wrote back last would
     * discard the other's change entirely.
     */
    router.patch("/:sceneId", async (req, res) => {
        const { sceneId } = req.params;
        try {
            if (!isValidSceneId(sceneId)) {
                return res.status(400).json({ error: "Invalid sceneId" });
            }
            const hasKnownField = req.body && (
                req.body.name !== undefined ||
                req.body.image !== undefined ||
                req.body.updateImage !== undefined ||
                req.body.removeImageId !== undefined ||
                req.body.reorderImageIds !== undefined
            );
            if (!hasKnownField) {
                return res.status(400).json({
                    error: "name, image, updateImage, removeImageId, or reorderImageIds is required",
                });
            }

            await store.withLock(sceneId, async () => {
                const scene = await store.get(sceneId);
                if (!scene) {
                    res.status(404).json({ error: "Scene not found" });
                    return;
                }

                let changed = false;

                if (req.body.name !== undefined) {
                    const result = normalizeSceneName(req.body.name);
                    if (result.error) {
                        res.status(400).json({ error: result.error });
                        return;
                    }
                    const scenes = await store.list();
                    if (isNameTaken(scenes, result.name, sceneId)) {
                        res.status(409).json({ error: `A scene named "${result.name}" already exists` });
                        return;
                    }
                    scene.name = result.name;
                    changed = true;
                }

                if (req.body.image !== undefined) {
                    const result = normalizeImage(req.body.image);
                    if (result.error) {
                        res.status(400).json({ error: result.error });
                        return;
                    }
                    const alreadyPresent = scene.images.some((img) => img.id === result.image.id);
                    if (!alreadyPresent) {
                        const existingTotal = scene.images.reduce((sum, img) => sum + img.src.length, 0);
                        if (existingTotal + result.image.src.length > MAX_SCENE_IMAGES_TOTAL_LENGTH) {
                            res.status(400).json({
                                error: "This scene is near its total image size limit; remove an image before adding another",
                            });
                            return;
                        }
                        scene.images.push(result.image);
                        changed = true;
                    }
                }

                if (req.body.updateImage !== undefined) {
                    const { id, ...fields } = req.body.updateImage || {};
                    const target = scene.images.find((img) => img.id === id);
                    if (!target) {
                        res.status(404).json({ error: "Image not found" });
                        return;
                    }
                    const result = applyImagePatch(target, fields);
                    if (result.error) {
                        res.status(400).json({ error: result.error });
                        return;
                    }
                    Object.assign(target, result.image);
                    changed = true;
                }

                if (req.body.removeImageId !== undefined) {
                    const before = scene.images.length;
                    scene.images = scene.images.filter((img) => img.id !== req.body.removeImageId);
                    if (scene.images.length !== before) {
                        changed = true;
                    }
                }

                if (req.body.reorderImageIds !== undefined) {
                    const ids = req.body.reorderImageIds;
                    const currentIds = scene.images.map((img) => img.id);
                    const isSamePermutation =
                        Array.isArray(ids) &&
                        ids.length === currentIds.length &&
                        [...ids].sort().join() === [...currentIds].sort().join();
                    if (!isSamePermutation) {
                        res.status(400).json({ error: "reorderImageIds must match the scene's current images" });
                        return;
                    }
                    scene.images = ids.map((id) => scene.images.find((img) => img.id === id));
                    changed = true;
                }

                if (changed) {
                    scene.updatedAt = nextUpdatedAt(scene.updatedAt);
                    await store.save(scene);
                }
                res.json(scene);
            });
        } catch (error) {
            sendStoreError(res, error, "Failed to update scene");
        }
    });

    /**
     * Permanently deletes a single scene. Confirmation happens in the UI. Issue #424.
     */
    router.delete("/:sceneId", async (req, res) => {
        try {
            const { sceneId } = req.params;
            if (!isValidSceneId(sceneId)) {
                return res.status(400).json({ error: "Invalid sceneId" });
            }

            // Under the scene's lock so a save that already read the scene
            // can't write it back after it has been deleted.
            const deleted = await store.withLock(sceneId, () => store.remove(sceneId));
            if (!deleted) {
                return res.status(404).json({ error: "Scene not found" });
            }
            res.status(204).end();
        } catch (error) {
            sendStoreError(res, error, "Failed to delete scene");
        }
    });

    /**
     * Saves a scene's full content in one request (Issues #451, #452, #454):
     * `images`, `annotations`, and (if sent) `importLog` replace the stored
     * ones together, so a scene is always stored as one coherent state. An
     * optional `name` renames it in the same write. When `baseUpdatedAt` is
     * sent and no longer matches the stored version, the save is refused with
     * 412 so a stale copy can't silently replace newer content saved from
     * somewhere else.
     */
    router.put("/:sceneId", async (req, res) => {
        const { sceneId } = req.params;
        try {
            const body = isPlainObject(req.body) ? req.body : {};
            const content = validateSceneContent(body);
            if (content.error) {
                return res.status(400).json({ error: content.error });
            }
            let name;
            if (body.name !== undefined) {
                const result = normalizeSceneName(body.name);
                if (result.error) {
                    return res.status(400).json({ error: result.error });
                }
                name = result.name;
            }
            if (body.baseUpdatedAt !== undefined && typeof body.baseUpdatedAt !== "string") {
                return res.status(400).json({ error: "baseUpdatedAt must be a string" });
            }

            await store.withLock(sceneId, async () => {
                const scene = await store.get(sceneId);
                if (!scene) {
                    res.status(404).json({ error: "Scene not found" });
                    return;
                }
                if (body.baseUpdatedAt !== undefined && body.baseUpdatedAt !== scene.updatedAt) {
                    res.status(412).json({
                        error: "This scene was changed somewhere else after you opened it",
                        updatedAt: scene.updatedAt,
                    });
                    return;
                }
                if (name !== undefined && isNameTaken(await store.list(), name, sceneId)) {
                    res.status(409).json({ error: `A scene named "${name}" already exists` });
                    return;
                }

                const updated = {
                    ...scene,
                    ...content,
                    name: name === undefined ? scene.name : name,
                    updatedAt: nextUpdatedAt(scene.updatedAt),
                };
                await store.save(updated);
                res.json(updated);
            });
        } catch (error) {
            sendStoreError(res, error, "Failed to save scene");
        }
    });



        /**
     * Publishes or unpublishes a scene (Issues #458, #459).
     * Body: { status: "draft" | "published" }. Responds with the scene's summary.
     * Only the status changes: the images, annotations, and `updatedAt` version
     * (which Save uses to detect conflicts) stay exactly the same, so publishing
     * never changes a scene's content and an open working copy can still be
     * saved normally afterwards.
     */
    router.patch("/:sceneId/status", async (req, res) => {
        const { sceneId } = req.params;
        const status = isPlainObject(req.body) ? req.body.status : undefined;
        if (!SCENE_STATUSES.includes(status)) {
            return res.status(400).json({ error: "status must be \"draft\" or \"published\"" });
        }
        try {
            await store.withLock(sceneId, async () => {
                const scene = await store.get(sceneId);
                if (!scene) {
                    res.status(404).json({ error: "Scene not found" });
                    return;
                }
                const updated = { ...scene, status };
                if (status === "published") {
                    updated.publishedAt = new Date().toISOString();
                } else {
                    delete updated.publishedAt;
                }
                await store.save(updated);
                res.json(toSummary(updated));
            });
        } catch (error) {
            sendStoreError(res, error, "Failed to change the scene's status");
        }
    });
    /**
     * Creates an independent copy of a saved scene with its own id and a
     * "<name> copy" name, numbered if taken (Issue #455).
     */
    router.post("/:sceneId/duplicate", async (req, res) => {
        const { sceneId } = req.params;
        try {
            await store.withLock(sceneId, async () => {
                const source = await store.get(sceneId);
                if (!source) {
                    res.status(404).json({ error: "Scene not found" });
                    return;
                }
                const now = new Date().toISOString();
                const copy = {
                    ...JSON.parse(JSON.stringify(source)),
                    id: crypto.randomUUID(),
                    name: nextCopyName(await store.list(), source.name),
                    // A copy is new, unfinished work even if the original is published.
                    status: "draft",
                    createdAt: now,
                    updatedAt: now,
                };
                delete copy.publishedAt;
                await store.save(copy);
                res.status(201).location(`${req.baseUrl}/${copy.id}`).json(copy);
            });
        } catch (error) {
            sendStoreError(res, error, "Failed to duplicate scene");
        }
    });

    /**
     * Builds the scene objects for an existing bone's images, ready to add to a
     * scene's working copy. Issue #466. Nothing is stored: the client adds the
     * result to its working copy, and it is saved with the user's other
     * changes by the normal Save (PUT), including its version check (Issue #451).
     * Body: { boneId, filenames?, annotations?, originY? }. `filenames` selects which of the bone's images
     * to import (default: all of them). `annotations` ({ labels, regions }, Issue #467) also imports
     * the bone's labels and pointer lines and/or colored regions (default: none).
     * `originY` is where the new row of images starts, normally just below the
     * working copy's existing images (default 0). Images are placed in the
     * order the viewer shows them. The response's `importLogEntry` records the
     * import, including anything that couldn't be converted, for the client to
     * add to the scene's importLog. Images that can't be imported are listed in
     * `warnings`; if none can be, the response is 422.
     */
    router.post("/:sceneId/import-legacy", async (req, res) => {
        const boneId = req.body ? req.body.boneId : undefined;
        if (!isValidBoneId(boneId)) {
            return res.status(400).json({ error: "A valid boneId is required" });
        }
        const filenames = req.body ? req.body.filenames : undefined;
        const validFilenames = filenames === undefined || (
            Array.isArray(filenames) &&
            filenames.length > 0 &&
            filenames.length <= 50 &&
            filenames.every((name) => typeof name === "string" && name.length > 0 && name.length <= 200)
        );
        if (!validFilenames) {
            return res.status(400).json({ error: "filenames must be a non-empty list of image file names" });
        }
        const include = req.body ? req.body.annotations : undefined;
        const validInclude = include === undefined || (
            include !== null &&
            typeof include === "object" &&
            !Array.isArray(include) &&
            Object.entries(include).every(([key, value]) => ["labels", "regions"].includes(key) && typeof value === "boolean")
        );
        if (!validInclude) {
            return res.status(400).json({ error: "annotations must be an object like { labels: true, regions: true }" });
        }
        const originY = req.body ? req.body.originY : undefined;
        if (originY !== undefined && !isFiniteNumber(originY)) {
            return res.status(400).json({ error: "originY must be a number" });
        }

        try {
            const result = await buildLegacyImages(boneId, {
                ...options.legacyContent,
                filenames,
                origin: { x: 0, y: originY === undefined ? 0 : originY },
            });
            if (result.images.length === 0) {
                return res.status(422).json({
                    error: `No images could be imported for ${result.name}`,
                    warnings: result.warnings,
                });
            }

            const annotationResult = await buildLegacyAnnotations(boneId, result.images, {
                include: include || {},
                allImagesImported: result.images.length === result.totalImages,
                annotationsDir: options.legacyContent && options.legacyContent.annotationsDir,
            });
            const warnings = [...result.warnings, ...annotationResult.warnings];
            res.json({
                images: result.images,
                annotations: annotationResult.annotations,
                importLogEntry: {
                    at: new Date().toISOString(),
                    boneId: result.boneId,
                    images: result.images.length,
                    annotations: annotationResult.counts,
                    warnings: warnings.slice(0, MAX_LOGGED_WARNINGS),
                },
                imported: { boneId: result.boneId, name: result.name, count: result.images.length },
                importedAnnotations: annotationResult.counts,
                warnings,
            });
        } catch (error) {
            if (error instanceof LegacyImportError) {
                return res.status(error.status).json({ error: error.message });
            }
            sendStoreError(res, error, "Failed to import images");
        }
    });

    return router;
}

module.exports = {
    createScenesRouter,
    createFileSceneStore,
    createRedisSceneStore,
    resolveSceneStore,
    isValidSceneId,
    normalizeSceneName,
    normalizeImage,
    applyImagePatch,
    validateSceneContent,
    SceneLockTimeoutError,
    DEFAULT_SCENE_NAME,
    MAX_SCENE_OBJECTS,
    MAX_IMPORT_LOG_ENTRIES,
    RELEASE_LOCK_SCRIPT,
    SCENE_LOCK_TTL_MS,
    MAX_IMAGE_SRC_LENGTH,
    MAX_SCENE_IMAGES_TOTAL_LENGTH,
};
