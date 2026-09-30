import { createContext, useContext } from 'react';

import { useStudioConnection } from '../hooks/useStudioConnection';

type StudioConnectionContextValue = ReturnType<typeof useStudioConnection>;

const StudioConnectionContext = createContext<StudioConnectionContextValue | undefined>(undefined);

export const StudioConnectionProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const connection = useStudioConnection();

  return (
    <StudioConnectionContext.Provider value={connection}>
      {children}
    </StudioConnectionContext.Provider>
  );
};

export const useStudioConnectionState = () => {
  const context = useContext(StudioConnectionContext);
  if (context === undefined) {
    throw new Error('useStudioConnectionState must be used within a StudioConnectionProvider');
  }
  return context;
};
