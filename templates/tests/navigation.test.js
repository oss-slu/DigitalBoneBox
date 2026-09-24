const {
    setupNavigation,
    setBoneAndSubbones,
    disableButtons,
} = require("../js/navigation.js");

function renderNavigationHTML() {
    document.body.innerHTML = `
        <button id="prev-button"></button>
        <button id="next-button"></button>
        <span id="text-button-Home" role="button"></span>
        <select id="subbone-select">
            <option value="">--Please choose a Bone Part--</option>
            <option value="subbone_a">Subbone A</option>
            <option value="subbone_b">Subbone B</option>
            <option value="subbone_c">Subbone C</option>
        </select>
    `;
}

describe("Prev/Next navigation keeps the dropdown and its listeners in sync - Issue 249", () => {
    let prevButton, nextButton, subboneDropdown, changeSpy;

    beforeEach(() => {
        renderNavigationHTML();
        prevButton = document.getElementById("prev-button");
        nextButton = document.getElementById("next-button");
        subboneDropdown = document.getElementById("subbone-select");

        setupNavigation(prevButton, nextButton, subboneDropdown);
        setBoneAndSubbones("ilium", ["subbone_a", "subbone_b", "subbone_c"]);
        disableButtons(prevButton, nextButton);

        // Standing in for the real listeners in dropdowns.js / HTMX that only
        // run when a real "change" event fires on the subbone dropdown.
        changeSpy = jest.fn();
        subboneDropdown.addEventListener("change", changeSpy);
    });

    test("clicking Next for the first time after selecting a bone shows the first subbone, not the second", () => {
        // Regression test: the dropdown still shows its placeholder right after a
        // bone is selected, so the first Next click must reveal subbones[0]. It must
        // not skip straight to subbones[1] as if subbones[0] had already been shown.
        nextButton.click();

        expect(subboneDropdown.value).toBe("subbone_a");
        expect(changeSpy).toHaveBeenCalledTimes(1);
    });

    test("clicking Next repeatedly walks through every subbone in order and stops at the last one", () => {
        nextButton.click(); // (none shown yet) -> subbone_a
        nextButton.click(); // subbone_a -> subbone_b
        nextButton.click(); // subbone_b -> subbone_c
        nextButton.click(); // already last subbone: no-op, no extra change event

        expect(subboneDropdown.value).toBe("subbone_c");
        expect(changeSpy).toHaveBeenCalledTimes(3);
    });

    test("clicking Previous dispatches a change event and moves back a subbone", () => {
        nextButton.click(); // -> subbone_a
        nextButton.click(); // -> subbone_b
        changeSpy.mockClear();

        prevButton.click();

        expect(subboneDropdown.value).toBe("subbone_a");
        expect(changeSpy).toHaveBeenCalledTimes(1);
    });

    test("clicking Previous before any Next click does nothing", () => {
        const valueBeforeClick = subboneDropdown.value;

        prevButton.click();

        expect(subboneDropdown.value).toBe(valueBeforeClick);
        expect(changeSpy).not.toHaveBeenCalled();
    });

    test("clicking Previous at the first subbone does nothing", () => {
        nextButton.click(); // -> subbone_a
        changeSpy.mockClear();

        prevButton.click();

        expect(subboneDropdown.value).toBe("subbone_a");
        expect(changeSpy).not.toHaveBeenCalled();
    });

    test("buttons are disabled when the current bone has no subbones", () => {
        setBoneAndSubbones("ischium", []);
        disableButtons(prevButton, nextButton);

        expect(prevButton.disabled).toBe(true);
        expect(nextButton.disabled).toBe(true);
    });
});
