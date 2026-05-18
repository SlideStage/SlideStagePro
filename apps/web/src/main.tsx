import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
} from 'react-router-dom';
import { App } from './App.js';
import { DeckListPage } from './pages/DeckListPage.js';
import { DeckViewerPage } from './pages/DeckViewerPage.js';
import { PresenterViewPage } from './pages/PresenterViewPage.js';
import { AudienceViewPage } from './pages/AudienceViewPage.js';
import { UploadPage } from './pages/UploadPage.js';
import { LandingPage } from './pages/LandingPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { RegisterPage } from './pages/RegisterPage.js';
import { ProfilePage } from './pages/ProfilePage.js';
import { AdminUsersPage } from './pages/AdminUsersPage.js';
import { RequireAuth } from './components/RequireAuth.js';
import { AuthProvider } from './hooks/useAuth.js';
import './styles/globals.css';

const router = createBrowserRouter([
  // Public landing page lives outside the authenticated `App` shell so it
  // can use its own full-bleed layout, hero typography and CTA card.
  // Authenticated users get bounced to `/decks` from inside the component.
  { path: '/', element: <LandingPage /> },
  {
    // Pathless layout route — everything below renders inside the `App`
    // header shell. React Router 6.4+ supports parent routes with no `path`.
    element: <App />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
      { path: '/profile', element: <RequireAuth><ProfilePage /></RequireAuth> },
      { path: '/admin/users', element: <RequireAuth><AdminUsersPage /></RequireAuth> },
      { path: '/decks', element: <RequireAuth><DeckListPage /></RequireAuth> },
      { path: '/decks/upload', element: <RequireAuth><UploadPage /></RequireAuth> },
      { path: '/decks/:deckId', element: <RequireAuth><DeckViewerPage /></RequireAuth> },
      {
        path: '/decks/:deckId/presenter',
        element: <RequireAuth><PresenterViewPage /></RequireAuth>,
      },
      {
        path: '/decks/:deckId/audience',
        element: <RequireAuth><AudienceViewPage /></RequireAuth>,
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <React.StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </React.StrictMode>,
);
