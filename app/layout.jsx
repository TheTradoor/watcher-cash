import '@solana/wallet-adapter-react-ui/styles.css';
import './globals.css';
import Providers from './providers';

export const metadata = {
  title: 'Watcher Cash — Privacy Designed To Disappear',
  description: 'A private Solana interface built on Privacy Cash infrastructure.',
};

export default function Layout({ children }) {
  return <html lang="en"><body><Providers>{children}</Providers></body></html>;
}
