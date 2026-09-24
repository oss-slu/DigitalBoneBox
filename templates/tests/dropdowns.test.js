jest.mock("../js/description.js", () => ({
    loadDescription: jest.fn(),
}));
jest.mock("../js/imageDisplay.js", () => ({
    displayBoneImages: jest.fn(),
    showPlaceholder: jest.fn(),
}));
jest.mock("../js/annotationOverlay.js", () => ({
    clearAnnotations: jest.fn(),
}));
jest.mock("../js/api.js", () => ({
    // Images are keyed by boneId so tests can confirm the correct parent's
    // images (not just any images) are displayed after a deselect.
    fetchBoneData: jest.fn((boneId) => Promise.resolve({ images: [{ url: `${boneId}.jpg` }] })),
}));

const { loadDescription } = require("../js/description.js");
const { showPlaceholder, displayBoneImages } = require("../js/imageDisplay.js");
const { fetchBoneData } = require("../js/api.js");
const { setupDropdownListeners, populateBonesetDropdown } = require("../js/dropdowns.js");

const combinedData = {
    bonesets: [{ id: "bony_pelvis", name: "Bony Pelvis" }],
    bones: [{ id: "ilium", name: "Ilium", boneset: "bony_pelvis" }],
    subbones: [{ id: "iliac_crest", name: "Iliac Crest", bone: "ilium" }],
};

function renderDropdownsHTML() {
    document.body.innerHTML = `
        <select id="boneset-select"></select>
        <select id="bone-select"></select>
        <select id="subbone-select"></select>
        <div id="bone-image-container"></div>
    `;
}

function selectValue(select, value) {
    select.value = value;
    select.dispatchEvent(new Event("change"));
}

describe("Deselecting a bone/sub-bone reverts to parent info - Issue 248", () => {
    let bonesetSelect, boneSelect, subboneSelect;

    beforeEach(() => {
        jest.clearAllMocks();
        renderDropdownsHTML();

        bonesetSelect = document.getElementById("boneset-select");
        boneSelect = document.getElementById("bone-select");
        subboneSelect = document.getElementById("subbone-select");

        // Populate the boneset options; the bone/sub-bone options are populated
        // dynamically by the listeners themselves as each level is selected.
        populateBonesetDropdown(combinedData.bonesets);
        setupDropdownListeners(combinedData);
    });

    test("deselecting a bone falls back to the boneset's description and images instead of the placeholder", async () => {
        selectValue(bonesetSelect, "bony_pelvis");
        selectValue(boneSelect, "ilium");
        await new Promise(process.nextTick);
        loadDescription.mockClear();
        showPlaceholder.mockClear();
        fetchBoneData.mockClear();
        displayBoneImages.mockClear();

        selectValue(boneSelect, "");
        await new Promise(process.nextTick);

        expect(loadDescription).toHaveBeenCalledWith("bony_pelvis");
        expect(showPlaceholder).not.toHaveBeenCalled();

        // Confirm the boneset's own images were fetched and rendered, not the
        // bone's images left over from before the deselect (nor a placeholder).
        expect(fetchBoneData).toHaveBeenCalledWith("bony_pelvis");
        expect(displayBoneImages).toHaveBeenCalledWith(
            [{ url: "bony_pelvis.jpg" }],
            expect.objectContaining({ boneId: "bony_pelvis" })
        );
    });

    test("deselecting a sub-bone falls back to the parent bone's description and images instead of the placeholder", async () => {
        selectValue(bonesetSelect, "bony_pelvis");
        selectValue(boneSelect, "ilium");
        selectValue(subboneSelect, "iliac_crest");
        await new Promise(process.nextTick);
        loadDescription.mockClear();
        showPlaceholder.mockClear();
        fetchBoneData.mockClear();
        displayBoneImages.mockClear();

        selectValue(subboneSelect, "");
        await new Promise(process.nextTick);

        expect(loadDescription).toHaveBeenCalledWith("ilium");
        expect(showPlaceholder).not.toHaveBeenCalled();

        // Confirm the parent bone's own images were fetched and rendered, not the
        // sub-bone's images left over from before the deselect (nor a placeholder).
        expect(fetchBoneData).toHaveBeenCalledWith("ilium");
        expect(displayBoneImages).toHaveBeenCalledWith(
            [{ url: "ilium.jpg" }],
            expect.objectContaining({ boneId: "ilium" })
        );
    });

    test("deselecting a bone with no boneset selected still shows the placeholder", async () => {
        selectValue(boneSelect, "");
        await new Promise(process.nextTick);

        expect(showPlaceholder).toHaveBeenCalled();
    });
});
