// boneset-api/scenes.js
// Scene Editor Workspace API (big rock #420) and scene persistence (big rock #451).
const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");

const DEFAULT_SCENE_NAME = "Untitled Scene";
const MAX_SCENE_NAME_LENGTH = 100;
const MAX_SCENE_OBJECTS = 1000;
const SCENE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateObjectList(list, field) {
    if (!Array.isArray(list)) {
        return `${field} must be an array`;
    }
    if (list.length > MAX_SCENE_OBJECTS) {
        return `${field} cannot contain more than ${MAX_SCENE_OBJECTS} items`;
    }
    if (!list.every(isPlainObject)) {
        return `Every item in ${field} must be an object`;
    }
    return null;
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
     * Returns a full scene (images and annotations) to open in the workspace. Issues #422, #425, #453.
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
     * Saves edited scene contents. Replaces the scene's images and annotations with
     * the ones sent; name is optional. id and createdAt are kept from the stored scene.
     * Issues #452, #454.
     */
    router.put("/:sceneId", async (req, res) => {
        try {
            const body = req.body;
            if (!isPlainObject(body)) {
                return res.status(400).json({ error: "Request body must be a JSON object" });
            }
            const contentError =
                validateObjectList(body.images, "images") ||
                validateObjectList(body.annotations, "annotations");
            if (contentError) {
                return res.status(400).json({ error: contentError });
            }

            let name;
            if (body.name !== undefined) {
                const result = normalizeSceneName(body.name);
                if (result.error) {
                    return res.status(400).json({ error: result.error });
                }
                name = result.name;
            }

            const { sceneId } = req.params;
            const scene = await store.get(sceneId);
            if (!scene) {
                return res.status(404).json({ error: "Scene not found" });
            }

            if (name !== undefined && name !== scene.name) {
                const scenes = await store.list();
                if (isNameTaken(scenes, name, sceneId)) {
                    return res.status(409).json({ error: `A scene named "${name}" already exists` });
                }
                scene.name = name;
            }

            scene.images = body.images;
            scene.annotations = body.annotations;
            scene.updatedAt = new Date().toISOString();
            await store.save(scene);
            res.json(scene);
        } catch (error) {
            sendStoreError(res, error, "Failed to save scene");
        }
    });

    /**
     * Renames a scene. Empty names are rejected; duplicate names return 409. Issue #423.
     */
    router.patch("/:sceneId", async (req, res) => {
        try {
            if (!req.body || req.body.name === undefined) {
                return res.status(400).json({ error: "name is required" });
            }
            const result = normalizeSceneName(req.body.name);
            if (result.error) {
                return res.status(400).json({ error: result.error });
            }

            const { sceneId } = req.params;
            const scene = await store.get(sceneId);
            if (!scene) {
                return res.status(404).json({ error: "Scene not found" });
            }

            const scenes = await store.list();
            if (isNameTaken(scenes, result.name, sceneId)) {
                return res.status(409).json({ error: `A scene named "${result.name}" already exists` });
            }

            scene.name = result.name;
            scene.updatedAt = new Date().toISOString();
            await store.save(scene);
            res.json(scene);
        } catch (error) {
            sendStoreError(res, error, "Failed to rename scene");
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
    DEFAULT_SCENE_NAME,
    MAX_SCENE_OBJECTS,
};
