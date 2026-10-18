import { Navigate, Route, Routes } from 'react-router-dom';

import { HomePage } from '../pages/HomePage.js';

/**
 * The route table. P2 wraps the authenticated routes in a session guard and adds
 * the sign-in and sign-up routes alongside it.
 */
export function App() {
  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
