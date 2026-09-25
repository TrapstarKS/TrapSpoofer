import { create } from 'zustand';

/** 0 = Fonte, 1 = Revisar, 2 = Enviar, 3 = Aplicar */
export type FlowStep = 0 | 1 | 2 | 3;
export type SourceTab = 'studio' | 'file' | 'manual';

interface FlowState {
  step: FlowStep;
  sourceTab: SourceTab;
  treeView: boolean;
  setStep: (step: FlowStep) => void;
  setSourceTab: (tab: SourceTab) => void;
  setTreeView: (tree: boolean) => void;
}

/** UI-only state of the Spoofar wizard (not persisted). */
export const useFlowStore = create<FlowState>((set) => ({
  step: 0,
  sourceTab: 'studio',
  treeView: false,
  setStep: (step) => set({ step }),
  setSourceTab: (sourceTab) => set({ sourceTab }),
  setTreeView: (treeView) => set({ treeView }),
}));
