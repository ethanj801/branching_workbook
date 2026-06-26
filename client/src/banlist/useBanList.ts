import { useCallback, useState } from "react";

import type { ProjectSettingsPatch } from "../api";

type BanListSettings = {
  banned_strings: string[];
  banned_strings_enabled: boolean;
};

/**
 * Owns the per-project banned-phrases list and its master on/off. The list and
 * the flag persist through the same project-settings plumbing as the branch
 * controls. Bans are compared case-insensitively because the backend lowercases
 * banned strings before matching, so "Suddenly" and "suddenly" are the same ban.
 */
export function useBanList(saveProjectSettings: (patch: ProjectSettingsPatch) => void) {
  const [bannedStrings, setBannedStrings] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);

  // These handlers compute the next value from current state and persist once,
  // rather than calling saveProjectSettings inside a setState updater. Updaters
  // are double-invoked under StrictMode, which would fire two concurrent PUTs
  // and trip the shared SQLite connection.
  function addBannedString(phrase: string) {
    // Drop trailing blank lines left over from the textarea, but keep interior
    // newlines and spaces so a multi-line phrase survives verbatim.
    const value = phrase.replace(/\n+$/, "");
    if (value.trim() === "") return;
    const exists = bannedStrings.some((s) => s.toLowerCase() === value.toLowerCase());
    if (exists) return;
    const next = [...bannedStrings, value];
    setBannedStrings(next);
    saveProjectSettings({ banned_strings: next });
  }

  function removeBannedStringAt(index: number) {
    const next = bannedStrings.filter((_, i) => i !== index);
    setBannedStrings(next);
    saveProjectSettings({ banned_strings: next });
  }

  function toggleEnabled() {
    const next = !enabled;
    setEnabled(next);
    saveProjectSettings({ banned_strings_enabled: next });
  }

  const hydrate = useCallback((settings: BanListSettings) => {
    setBannedStrings(settings.banned_strings);
    setEnabled(settings.banned_strings_enabled);
  }, []);

  return {
    bannedStrings,
    enabled,
    addBannedString,
    removeBannedStringAt,
    toggleEnabled,
    hydrate,
  };
}

export type BanList = ReturnType<typeof useBanList>;
