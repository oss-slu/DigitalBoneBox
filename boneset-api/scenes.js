// boneset-api/scenes.js
// Scene Editor Workspace API (big rock #420).
const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");

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

function toSummary(scene) {
    return {
        id: scene.id,
        name: scene.name,
        imageCount: (scene.images || []).length,
        annotationCount: (scene.annotations || []).length,
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

// How long a PATCH will wait for another PATCH on the same scene before giving
// up (returns 409 "busy" rather than hanging indefinitely), and how long a
// held lock survives if its holder crashes before releasing it.
const SCENE_LOCK_WAIT_MS = 3000;
const SCENE_LOCK_POLL_MS = 50;
const SCENE_LOCK_TTL_MS = 5000;

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
     * Distributed per-scene lock (PR #493 review fix) so a rename and an image
     * save racing each other across serverless invocations can't clobber one
     * another the way two unserialized read-modify-writes otherwise would. The
     * TTL is a safety net if a holder crashes; the token check on release
     * avoids deleting a lock we no longer own after it already expired.
     */
    async function withLock(sceneId, fn) {
        const key = lockKey(sceneId);
        const token = crypto.randomUUID();
        const deadline = Date.now() + SCENE_LOCK_WAIT_MS;
        for (;;) {
            const acquired = await redis.set(key, token, { nx: true, px: SCENE_LOCK_TTL_MS });
            if (acquired) {
                try {
                    return await fn();
                } finally {
                    const current = await redis.get(key);
                    if (current === token) await redis.del(key);
                }
            }
            if (Date.now() >= deadline) {
                throw new SceneLockTimeoutError("Scene is busy, try again");
            }
            await new Promise((resolve) => setTimeout(resolve, SCENE_LOCK_POLL_MS));
        }
    }

    return { list, get, save, remove, withLock };
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

function nextDefaultName(scenes) {
    if (!isNameTaken(scenes, DEFAULT_SCENE_NAME)) return DEFAULT_SCENE_NAME;
    let n = 2;
    while (isNameTaken(scenes, `${DEFAULT_SCENE_NAME} ${n}`)) n += 1;
    return `${DEFAULT_SCENE_NAME} ${n}`;
}

function sendStoreError(res, error, message) {
    if (error instanceof SceneStorageUnavailableError) {
        return res.status(503).json({ error: error.message });
    }
    if (error instanceof SceneLockTimeoutError) {
        return res.status(409).json({ error: error.message });
    }
    console.error(`${message}:`, error.message);
    return res.status(500).json({ error: message });
}

function createScenesRouter(store = resolveSceneStore()) {
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
    router.get("/", async (_req, res) => {
        try {
            const scenes = await store.list();
            scenes.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
            res.json({ scenes: scenes.map(toSummary) });
        } catch (error) {
            sendStoreError(res, error, "Failed to list scenes");
        }
    });

    /**
     * Creates a new blank scene with a unique id. Name is optional and defaults
     * to "Untitled Scene" (numbered if taken). Issues #421, #423.
     */
    router.post("/", async (req, res) => {
        try {
            const scenes = await store.list();
            let name;
            if (req.body && req.body.name !== undefined) {
                const result = normalizeSceneName(req.body.name);
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
                images: [],
                annotations: [],
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
     * 409 - Issue #423) and/or adding one newly imported image (validated and
     * upserted by id so a retried request can't create a duplicate - Issue #412).
     * At least one of `name`/`image` must be present in the body. The whole
     * read-modify-write runs under a per-scene lock (PR #493 review) so a
     * rename and an image save racing each other can't silently clobber one
     * another - without it, both would read the same snapshot and whichever
     * wrote back last would discard the other's change entirely.
     */
    router.patch("/:sceneId", async (req, res) => {
        const { sceneId } = req.params;
        try {
            if (!isValidSceneId(sceneId)) {
                return res.status(400).json({ error: "Invalid sceneId" });
            }
            if (!req.body || (req.body.name === undefined && req.body.image === undefined)) {
                return res.status(400).json({ error: "name or image is required" });
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

                if (changed) {
                    scene.updatedAt = new Date().toISOString();
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

            const deleted = await store.remove(sceneId);
            if (!deleted) {
                return res.status(404).json({ error: "Scene not found" });
            }
            res.status(204).end();
        } catch (error) {
            sendStoreError(res, error, "Failed to delete scene");
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
    DEFAULT_SCENE_NAME,
    MAX_IMAGE_SRC_LENGTH,
    MAX_SCENE_IMAGES_TOTAL_LENGTH,
};
