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
const SAFE_IMAGE_SRC_PREFIX = /^data:image\//i;

class SceneStorageUnavailableError extends Error {}

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
    const scenePath = (sceneId) => path.join(scenesDir, `${sceneId}.json`);

    async function ensureDir() {
        await fs.mkdir(scenesDir, { recursive: true });
    }

    async function get(sceneId) {
        try {
            const raw = await fs.readFile(scenePath(sceneId), "utf8");
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
        await ensureDir();
        const target = scenePath(scene.id);
        const tmp = `${target}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(scene, null, 2), "utf8");
        await fs.rename(tmp, target);
        return scene;
    }

    async function remove(sceneId) {
        try {
            await fs.unlink(scenePath(sceneId));
            return true;
        } catch (error) {
            if (error.code === "ENOENT") return false;
            throw error;
        }
    }

    return { list, get, save, remove };
}

// Durable shared storage for deployments. Each scene is stored under its own key,
// and a set tracks every scene id so the list route doesn't need to scan keys.
function createRedisSceneStore(redis, prefix = "bonebox") {
    const indexKey = `${prefix}:scenes`;
    const sceneKey = (sceneId) => `${prefix}:scene:${sceneId}`;

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

    return { list, get, save, remove };
}

function createUnavailableSceneStore(reason) {
    const fail = async () => {
        throw new SceneStorageUnavailableError(reason);
    };
    return { list: fail, get: fail, save: fail, remove: fail };
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
            const scene = await store.get(req.params.sceneId);
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
     * At least one of `name`/`image` must be present in the body.
     */
    router.patch("/:sceneId", async (req, res) => {
        try {
            if (!req.body || (req.body.name === undefined && req.body.image === undefined)) {
                return res.status(400).json({ error: "name or image is required" });
            }

            const { sceneId } = req.params;
            const scene = await store.get(sceneId);
            if (!scene) {
                return res.status(404).json({ error: "Scene not found" });
            }

            let changed = false;

            if (req.body.name !== undefined) {
                const result = normalizeSceneName(req.body.name);
                if (result.error) {
                    return res.status(400).json({ error: result.error });
                }
                const scenes = await store.list();
                if (isNameTaken(scenes, result.name, sceneId)) {
                    return res.status(409).json({ error: `A scene named "${result.name}" already exists` });
                }
                scene.name = result.name;
                changed = true;
            }

            if (req.body.image !== undefined) {
                const result = normalizeImage(req.body.image);
                if (result.error) {
                    return res.status(400).json({ error: result.error });
                }
                const alreadyPresent = scene.images.some((img) => img.id === result.image.id);
                if (!alreadyPresent) {
                    scene.images.push(result.image);
                    changed = true;
                }
            }

            if (changed) {
                scene.updatedAt = new Date().toISOString();
                await store.save(scene);
            }
            res.json(scene);
        } catch (error) {
            sendStoreError(res, error, "Failed to update scene");
        }
    });

    /**
     * Permanently deletes a single scene. Confirmation happens in the UI. Issue #424.
     */
    router.delete("/:sceneId", async (req, res) => {
        try {
            const deleted = await store.remove(req.params.sceneId);
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
};
