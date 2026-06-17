import { describe, expect, it } from "vitest";

import {
  modelNameFromDownload,
  selectedModelNameAfterDownload,
} from "./useModelLoader";

describe("modelNameFromDownload", () => {
  it("prefers an explicit download folder", () => {
    expect(
      modelNameFromDownload("lucyknada/google_gemma-3-270m-exl3", "gemma-local"),
    ).toBe("gemma-local");
  });

  it("falls back to the repo leaf", () => {
    expect(modelNameFromDownload("lucyknada/google_gemma-3-270m-exl3", "")).toBe(
      "google_gemma-3-270m-exl3",
    );
  });

  it("ignores empty repo path segments", () => {
    expect(modelNameFromDownload("lucyknada/google_gemma-3-270m-exl3/", "")).toBe(
      "google_gemma-3-270m-exl3",
    );
  });
});

describe("selectedModelNameAfterDownload", () => {
  it("auto-selects the downloaded model when the selection is unchanged", () => {
    expect(
      selectedModelNameAfterDownload({
        currentSelection: "existing-model",
        selectionAtDownloadStart: "existing-model",
        downloadedModelName: "downloaded-model",
        selectionChangedDuringDownload: false,
      }),
    ).toBe("downloaded-model");
  });

  it("preserves a different user selection made during the download", () => {
    expect(
      selectedModelNameAfterDownload({
        currentSelection: "user-picked-model",
        selectionAtDownloadStart: "existing-model",
        downloadedModelName: "downloaded-model",
        selectionChangedDuringDownload: true,
      }),
    ).toBe("user-picked-model");
  });

  it("auto-selects from an empty initial selection if only refresh filled it", () => {
    expect(
      selectedModelNameAfterDownload({
        currentSelection: "refresh-picked-model",
        selectionAtDownloadStart: "",
        downloadedModelName: "downloaded-model",
        selectionChangedDuringDownload: false,
      }),
    ).toBe("downloaded-model");
  });

  it("preserves a user selection made from an empty initial selection", () => {
    expect(
      selectedModelNameAfterDownload({
        currentSelection: "user-picked-model",
        selectionAtDownloadStart: "",
        downloadedModelName: "downloaded-model",
        selectionChangedDuringDownload: true,
      }),
    ).toBe("user-picked-model");
  });
});
