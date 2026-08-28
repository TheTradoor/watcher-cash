import '@solana/wallet-adapter-react-ui/styles.css';
import './globals.css';
import './motion-theme.css';
import './motion.css';
import './video-bg.css';
import Providers from './providers';
import WatcherBackgroundVideo from './background-video';

export const metadata = {
  title: 'Watcher Cash — Local Proofs on Solana',
  description: 'A development Solana privacy vault with browser-local Groth16 proving and on-chain verification.',
  robots: {
    index: false,
    follow: false,
  },
};

export default function Layout({ children }) {
  return (
    <html lang="en">
      <body>
        <WatcherBackgroundVideo />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
