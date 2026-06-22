import type { ViewModel } from "@/lib/viewModel";
import type { UiState } from "@/lib/types";

export interface Actions {
  setScreen: (s: UiState["screen"]) => void;
  setTheme: (t: UiState["theme"]) => void;
  setFilter: (f: UiState["txFilter"]) => void;
  setPeriod: (p: UiState["period"]) => void;
  setQuery: (q: string) => void;
  toggleNotif: (key: string) => void;
  toggleChan: (key: string) => void;
  logout: () => void;
}

export interface ScreenProps {
  vm: ViewModel;
  ui: UiState;
  actions: Actions;
}
