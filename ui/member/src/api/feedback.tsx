// One app-wide MUI Snackbar for errors and confirmations.
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';

type Severity = 'error' | 'success' | 'info';

export interface Feedback {
  show(message: string, severity?: Severity): void;
}

const FeedbackContext = createContext<Feedback | null>(null);

export function useFeedback(): Feedback {
  const feedback = useContext(FeedbackContext);
  if (feedback === null) {
    throw new Error('useFeedback must be used inside FeedbackProvider');
  }
  return feedback;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState<Severity>('info');

  const show = useCallback((text: string, level: Severity = 'info') => {
    setMessage(text);
    setSeverity(level);
    setOpen(true);
  }, []);
  const value = useMemo(() => ({ show }), [show]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <Snackbar
        open={open}
        autoHideDuration={5000}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert
          severity={severity}
          variant="filled"
          onClose={() => setOpen(false)}
          sx={{ width: '100%' }}
        >
          {message}
        </Alert>
      </Snackbar>
    </FeedbackContext.Provider>
  );
}
