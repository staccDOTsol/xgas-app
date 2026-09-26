import React, { useState, useEffect } from 'react';
import { OrbitXMoneyOtc } from './components/OrbitXMoneyOtc';
import { NguLaunchpad } from './components/NguLaunchpad';
import { McpConnector } from './components/McpConnector';
import { RobinhoodOtc, rememberRobinhoodReturn, restoreRobinhoodReturn } from './components/RobinhoodOtc';
import { Hero } from './components/Hero';
import { UserWallet } from './types';
import { connectInjectedWallet, switchNetwork, addXMoneyTokenToWallet, addOrbitL4ToWallet, loadL4Info, fetchL4XMoneyBalance, orbitL4RpcUrl, fetchXSession, xLoginUrl, xLogout, type XUser, L3_CHAIN_ID, L4_CHAIN_ID } from './contracts/web3Client';
import { CONTRACT_ADDRESSES } from './contracts/abis';
import { sounds } from './utils/audio';
import { Layers, Wallet, Volume2, VolumeX, AlertTriangle, Check, Plus, LogOut } from 'lucide-react';

const KNOWN_CHAINS = new Set<number>([L3_CHAIN_ID, L4_CHAIN_ID]);

// Remembers an explicit Disconnect across reloads, so the site does not silently reconnect through eth_accounts.
const DISCONNECT_KEY = 'xgas.walletDisconnected';
function walletDisconnectedFlag(): boolean {
  try { return localStorage.getItem(DISCONNECT_KEY) === '1'; } catch { return false; }
}
function setWalletDisconnectedFlag(on: boolean) {
  try { on ? localStorage.setItem(DISCONNECT_KEY, '1') : localStorage.removeItem(DISCONNECT_KEY); } catch { /* storage blocked */ }
}
// The retired chain. A wallet still on it gets told why, not just that it is on the wrong network.
const LEGACY_L4_CHAIN_ID = CONTRACT_ADDRESSES.ORBIT_L4_LEGACY_CHAIN_ID;

type AppTab = 'mcp' | 'otc' | 'ngu' | 'robinhood';
// /robinhood (and anything under it) is the X Money dollars <-> ETH desk on Robinhood Chain. The Express catch-all
// serves index.html for it, so the path alone decides the tab on load and on back/forward.
const isRobinhoodPath = () => typeof window !== 'undefined' && /^\/robinhood(\/|$)/i.test(window.location.pathname);

function shortChainLabel(id: number): string {
  if (id === L4_CHAIN_ID) return 'L4';
  if (id === L3_CHAIN_ID) return 'L3';
  return `#${id}`;
}

function chainLabel(id: number): string {
  if (id === L4_CHAIN_ID) return `xgas Orbit L4 (#${L4_CHAIN_ID})`;
  if (id === L3_CHAIN_ID) return `Robinhood L3 (#${L3_CHAIN_ID})`;
  return `Chain #${id}`;
}

export default function App() {
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [currentChainId, setCurrentChainId] = useState<number>(L4_CHAIN_ID);
  const [isWrongNetwork, setIsWrongNetwork] = useState(false);
  const [tokenImported, setTokenImported] = useState(false);
  const [l4Added, setL4Added] = useState(false);
  const [l4Ready, setL4Ready] = useState<boolean | null>(null);
  // Wallet's own view of the L4 balance vs the sequencer's: a mismatch means the wallet's
  // network entry for the L4 points at a stale RPC.
  const [rpcMismatch, setRpcMismatch] = useState<{ wallet: number; sequencer: number } | null>(null);
  const [xUser, setXUser] = useState<XUser | null>(null);
  const [xConfigured, setXConfigured] = useState<boolean>(false);
  const [tab, setTabState] = useState<AppTab>(() => {
    // Back from Sign in with X: put a parked /robinhood/order/:id or /robinhood/trade/:id link back before anything reads the path.
    restoreRobinhoodReturn();
    return isRobinhoodPath() ? 'robinhood' : 'otc';
  });
  // The desk tab owns /robinhood; every other tab lives under '/' (the OTC desk then writes its own sub-path).
  // The tab is also kept in history.state (appTab) so back/forward returns to MCP or NGU, not just the OTC desk.
  const setTab = (next: AppTab) => {
    if (next === tab) return;
    if (next === 'robinhood') {
      if (!isRobinhoodPath()) {
        window.history.replaceState({ ...(window.history.state || {}), appTab: tab }, '');
        window.history.pushState({ appTab: 'robinhood' }, '', '/robinhood');
      }
    } else if (isRobinhoodPath()) {
      window.history.pushState({ appTab: next }, '', '/');
    } else {
      window.history.replaceState({ ...(window.history.state || {}), appTab: next }, '');
    }
    setTabState(next);
  };
  // A direct visit to /robinhood lands on the desk, not on the hero above it.
  useEffect(() => {
    if (!isRobinhoodPath()) return;
    requestAnimationFrame(() => {
      const el = document.getElementById('play');
      if (!el) return;
      // Clear the sticky header, which is two rows tall on phones.
      const headerH = document.querySelector('header')?.getBoundingClientRect().height ?? 0;
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - headerH - 8 });
    });
  }, []);
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      if (isRobinhoodPath()) { setTabState('robinhood'); return; }
      const saved = e.state?.appTab as AppTab | undefined;
      if (saved && saved !== 'robinhood') setTabState(saved);
      else setTabState(prev => (prev === 'robinhood' ? 'otc' : prev));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Sign in with X session
  useEffect(() => {
    fetchXSession().then(({ configured, user }) => { setXConfigured(configured); setXUser(user); });
    const params = new URLSearchParams(window.location.search);
    if (params.get('xauth') === 'denied') {
      console.warn('X sign-in denied:', params.get('reason'));
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const handleXLogout = async () => {
    await xLogout();
    setXUser(null);
  };

  const [wallet, setWallet] = useState<UserWallet>({
    connected: false,
    address: '',
    balanceETH: 0,
    balanceWETH: 0,
    balanceUSDG: 0,
    nftHoldings: {}
  });

  // Discover the L4 contract addresses from the sequencer host
  useEffect(() => {
    let mounted = true;
    const tick = async () => {
      const info = await loadL4Info(true);
      if (mounted) setL4Ready(info ? !!info.ready : false);
    };
    tick();
    const t = setInterval(tick, 15000);
    return () => { mounted = false; clearInterval(t); };
  }, []);

  // Detect a wallet whose L4 network entry uses the wrong RPC
  useEffect(() => {
    const ethereum = (window as any).ethereum;
    if (!ethereum || !wallet.connected || currentChainId !== L4_CHAIN_ID) {
      setRpcMismatch(null);
      return;
    }
    let mounted = true;
    const check = async () => {
      try {
        const [hex, seq] = await Promise.all([
          ethereum.request({ method: 'eth_getBalance', params: [wallet.address, 'latest'] }) as Promise<string>,
          fetchL4XMoneyBalance(wallet.address),
        ]);
        const w = Number(BigInt(hex)) / 1e18;
        if (mounted) setRpcMismatch(Math.abs(w - seq) > 1e-6 ? { wallet: w, sequencer: seq } : null);
      } catch {
        if (mounted) setRpcMismatch(null);
      }
    };
    check();
    const t = setInterval(check, 10000);
    return () => { mounted = false; clearInterval(t); };
  }, [wallet.connected, wallet.address, currentChainId]);

  // Listen to wallet chain changes & account changes
  useEffect(() => {
    const ethereum = (window as any).ethereum;
    if (!ethereum) return;

    ethereum.request({ method: 'eth_chainId' }).then((hex: string) => {
      const id = parseInt(hex, 16);
      setCurrentChainId(id);
      setIsWrongNetwork(!KNOWN_CHAINS.has(id));
    }).catch(() => {});

    ethereum.request({ method: 'eth_accounts' }).then((accounts: string[]) => {
      if (accounts && accounts.length > 0 && !walletDisconnectedFlag()) {
        setWallet(prev => ({ ...prev, connected: true, address: accounts[0] }));
      }
    }).catch(() => {});

    const handleChainChanged = (hex: string) => {
      const id = parseInt(hex, 16);
      setCurrentChainId(id);
      setIsWrongNetwork(!KNOWN_CHAINS.has(id));
    };

    const handleAccountsChanged = (accounts: string[]) => {
      if (accounts && accounts.length > 0 && !walletDisconnectedFlag()) {
        setWallet(prev => ({ ...prev, connected: true, address: accounts[0] }));
      } else {
        setWallet(prev => ({ ...prev, connected: false, address: '' }));
      }
    };

    ethereum.on('chainChanged', handleChainChanged);
    ethereum.on('accountsChanged', handleAccountsChanged);

    return () => {
      if (ethereum.removeListener) {
        ethereum.removeListener('chainChanged', handleChainChanged);
        ethereum.removeListener('accountsChanged', handleAccountsChanged);
      }
    };
  }, []);

  const [walletMenu, setWalletMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!walletMenu) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement)?.closest?.('[data-wallet-menu]')) setWalletMenu(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [walletMenu]);

  // Switch account: ask the wallet to show its account picker again.
  const handleSwitchAccount = async () => {
    setWalletMenu(false);
    const ethereum = (window as any).ethereum;
    if (!ethereum) return;
    try {
      await ethereum.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
      const accounts: string[] = await ethereum.request({ method: 'eth_accounts' });
      setWalletDisconnectedFlag(false);
      if (accounts?.[0]) setWallet(prev => ({ ...prev, connected: true, address: accounts[0] }));
    } catch (e) {
      console.warn('Switch account cancelled:', e);
    }
  };

  // Disconnect: revoke this site's access where the wallet supports it (MetaMask, Rabby), and forget it here either way.
  const handleDisconnectWallet = async () => {
    setWalletMenu(false);
    setWalletDisconnectedFlag(true);
    setWallet(prev => ({ ...prev, connected: false, address: '' }));
    const ethereum = (window as any).ethereum;
    try { await ethereum?.request?.({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }); } catch { /* not supported: the local flag still keeps it disconnected */ }
  };

  const handleCopyAddress = async () => {
    try { await navigator.clipboard.writeText(wallet.address); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* clipboard blocked */ }
  };

  const handleConnectWallet = async () => {
    try {
      setWalletDisconnectedFlag(false);
      const res = await connectInjectedWallet();
      if (res.success && res.address) {
        setWallet(prev => ({ ...prev, connected: true, address: res.address! }));
        if (res.chainId) {
          setCurrentChainId(res.chainId);
          setIsWrongNetwork(!KNOWN_CHAINS.has(res.chainId));
        }
        if (soundEnabled && sounds.enabled) {
          sounds.playConnect();
        }
      }
    } catch (e) {
      console.warn('Wallet connection error:', e);
    }
  };

  // Default network is the xgas Orbit L4; the vault on-/off-ramp switches to Robinhood L3 by itself when needed.
  const handleFixNetwork = async () => {
    const ok = await switchNetwork(L4_CHAIN_ID);
    if (ok) {
      setCurrentChainId(L4_CHAIN_ID);
      setIsWrongNetwork(false);
      setL4Added(true);
      if (soundEnabled && sounds.enabled) {
        sounds.playConnect();
      }
    }
  };

  const handleAddL4 = async () => {
    const ok = await addOrbitL4ToWallet();
    if (ok) {
      setL4Added(true);
      if (soundEnabled && sounds.enabled) sounds.playConnect();
      setTimeout(() => setL4Added(false), 3000);
    }
  };

  const handleImportToken = async () => {
    const ok = await addXMoneyTokenToWallet();
    if (ok) {
      setTokenImported(true);
      if (soundEnabled && sounds.enabled) {
        sounds.playConnect();
      }
      setTimeout(() => setTokenImported(false), 3000);
    }
  };

  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    sounds.enabled = next;
    if (next) sounds.playConnect();
  };

  const onL4 = currentChainId === L4_CHAIN_ID;

  return (
    <div className="min-h-screen bg-[#07090e] text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-black">
      {/* Network Alert Banner if on an unknown chain */}
      {isWrongNetwork && (
        <div className="bg-rose-500/20 border-b border-rose-500/40 px-4 py-2 text-center text-xs font-mono flex items-center justify-center gap-2 text-rose-300 animate-pulse">
          <AlertTriangle className="w-4 h-4 text-rose-400" />
          <span>
            {currentChainId === LEGACY_L4_CHAIN_ID
              ? <>Wallet is on #{LEGACY_L4_CHAIN_ID}, the retired xgas chain. xgas now runs on #{L4_CHAIN_ID}. If your wallet's old network uses {orbitL4RpcUrl()}, delete it, then switch.</>
              : <>Wallet is on Chain #{currentChainId}. Expected xgas Orbit L4 (#{L4_CHAIN_ID}) or its parent Robinhood Chain (#{L3_CHAIN_ID}).</>}
          </span>
          <button
            onClick={handleFixNetwork}
            className="px-3 py-1 rounded-lg bg-rose-500 hover:bg-rose-400 text-slate-950 font-black uppercase text-[10px] cursor-pointer shadow-md"
          >
            Switch to Orbit L4 #{L4_CHAIN_ID}
          </button>
        </div>
      )}

      {rpcMismatch && (
        <div className="bg-amber-500/20 border-b border-amber-500/40 px-4 py-2 text-center text-xs font-mono text-amber-200 flex flex-wrap items-center justify-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <span>
            Your wallet's "xgas Orbit L4" network is reading a stale RPC (wallet sees {rpcMismatch.wallet.toFixed(5)} $xMoney, the sequencer holds {rpcMismatch.sequencer.toFixed(5)}).
            Edit that network in your wallet and set its RPC URL to <strong className="text-white select-all">{orbitL4RpcUrl()}</strong> (chain ID {L4_CHAIN_ID}), or delete it and click "+ Add Orbit L4".
          </span>
          <button
            onClick={() => navigator.clipboard.writeText(orbitL4RpcUrl())}
            className="px-2 py-0.5 rounded bg-amber-500 text-slate-950 font-black uppercase text-[10px] cursor-pointer"
          >
            Copy RPC URL
          </button>
        </div>
      )}

      {l4Ready === false && (
        <div className="bg-amber-500/15 border-b border-amber-500/40 px-4 py-1.5 text-center text-[11px] font-mono text-amber-300">
          xgas Orbit L4 sequencer is booting. L4 reads and trades will resume automatically.
        </div>
      )}

      {/* Top Header */}
      <header className="border-b border-[#1b2338] bg-[#0b0e17] sticky top-0 z-40 px-3 sm:px-6 py-2 sm:py-3">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 max-w-[1780px] mx-auto">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-emerald-500 via-teal-400 to-cyan-400 p-0.5 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <div className="w-full h-full bg-[#090b10] rounded-[10px] flex items-center justify-center">
                <Layers className="w-4 h-4 text-emerald-400" />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-black text-lg sm:text-xl text-white font-display tracking-tight">
                  XMONEY<span className="text-emerald-400"> ORBIT</span>
                </span>
                <span className="hidden sm:inline px-1.5 py-0.5 rounded text-[10px] font-black bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 font-mono">
                  L4 #{L4_CHAIN_ID}
                </span>
                <span className="hidden sm:inline px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#121624] text-slate-400 border border-[#1e2538] font-mono">
                  settles on Robinhood #{L3_CHAIN_ID}
                </span>
              </div>
            </div>
          </div>

          {/* Primary: network + wallet (row 1 on phones, far right on desktop) */}
          <div className="ml-auto flex items-center gap-2 md:order-last">
            <button
              onClick={handleFixNetwork}
              className={`px-2.5 sm:px-3 py-1.5 rounded-xl border text-xs font-mono font-bold flex items-center gap-2 transition-colors cursor-pointer ${
                isWrongNetwork
                  ? 'bg-rose-500/20 border-rose-500/40 text-rose-300 animate-pulse'
                  : 'bg-[#121624] hover:bg-[#1a2033] border-[#1e2538] text-slate-200'
              }`}
              title={onL4 ? 'Connected to xgas Orbit L4' : 'Switch wallet to xgas Orbit L4'}
            >
              <span className={`w-2 h-2 rounded-full ${isWrongNetwork ? 'bg-rose-500 animate-ping' : onL4 ? 'bg-emerald-400' : 'bg-cyan-400'}`} />
              <span className="sm:hidden">{isWrongNetwork ? `→ L4` : shortChainLabel(currentChainId)}</span>
              <span className="hidden sm:inline">{isWrongNetwork ? `Switch to L4 #${L4_CHAIN_ID}` : chainLabel(currentChainId)}</span>
            </button>

            <div className="relative" data-wallet-menu>
            <button
              onClick={() => (wallet.connected ? setWalletMenu(m => !m) : handleConnectWallet())}
              className={`px-3 sm:px-4 py-2 rounded-xl text-xs font-bold font-mono transition-all flex items-center gap-2 cursor-pointer shadow-md ${
                wallet.connected
                  ? 'bg-[#121624] border border-emerald-500/40 text-emerald-400'
                  : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black shadow-emerald-500/20'
              }`}
            >
              <Wallet className="w-3.5 h-3.5" />
              <span>
                {wallet.connected
                  ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`
                  : 'Connect'}
              </span>
            </button>
            {wallet.connected && walletMenu && (
              <div className="absolute right-0 mt-2 w-56 z-50 rounded-xl bg-[#0d111c] border border-[#1e2538] shadow-xl p-1.5 font-mono text-xs">
                <div className="px-2.5 py-2 text-slate-400 break-all">{wallet.address}</div>
                <button onClick={handleCopyAddress} className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-[#1a2033] text-slate-200 cursor-pointer">{copied ? 'Copied' : 'Copy address'}</button>
                <button onClick={handleSwitchAccount} className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-[#1a2033] text-slate-200 cursor-pointer">Switch account</button>
                <button onClick={handleDisconnectWallet} className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-rose-500/10 text-rose-300 cursor-pointer">Disconnect</button>
              </div>
            )}
            </div>
          </div>

          {/* Secondary rail: scrolls sideways on phones, inline on desktop */}
          <div className="basis-full md:basis-auto md:ml-auto flex items-center gap-2 overflow-x-auto no-scrollbar -mx-3 px-3 md:mx-0 md:px-0 [&>*]:shrink-0">
            {/* Sign in with X: verified handle for orders, trades and the game */}
            {xUser ? (
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-xl bg-[#121624] border border-emerald-500/40 text-xs font-mono font-bold text-emerald-300" title={`Signed in as @${xUser.handle}`}>
                {xUser.avatar ? <img src={xUser.avatar} alt="" className="w-5 h-5 rounded-full" /> : <span className="w-5 h-5 rounded-full bg-emerald-500/30 flex items-center justify-center text-[10px] text-white">X</span>}
                <span>@{xUser.handle}</span>
                <button onClick={handleXLogout} className="p-1 rounded-lg hover:bg-[#1a2033] text-slate-400 hover:text-white cursor-pointer" title="Sign out of X">
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <a
                href={xConfigured ? xLoginUrl() : undefined}
                onClick={xConfigured ? rememberRobinhoodReturn : (e) => { e.preventDefault(); alert('Sign in with X is not configured yet (X_CLIENT_ID secret missing on the host).'); }}
                className={`px-3 py-1.5 rounded-xl border text-xs font-mono font-bold flex items-center gap-1.5 transition-colors cursor-pointer ${xConfigured ? 'bg-white text-black border-white hover:bg-slate-200' : 'bg-[#121624] border-[#1e2538] text-slate-500'}`}
                title={xConfigured ? 'Verify your X handle for orders, trades and the game' : 'X OAuth not configured on the host yet'}
              >
                <span className="font-black">𝕏</span>
                <span>Sign in</span>
              </a>
            )}

            {/* 1-Click Add Orbit L4 network */}
            <button
              onClick={handleAddL4}
              className="flex px-3 py-1.5 rounded-xl bg-[#121624] hover:bg-[#1a2033] border border-[#1e2538] text-xs font-mono font-bold text-slate-300 items-center gap-1.5 transition-colors cursor-pointer"
              title="Add the xgas Orbit L4 network (native $xMoney) to Rabby / MetaMask"
            >
              {l4Added ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Plus className="w-3.5 h-3.5 text-emerald-400" />}
              <span>{l4Added ? 'L4 Added!' : '+ Add Orbit L4'}</span>
            </button>

            {/* 1-Click Import L3 claim token */}
            <button
              onClick={handleImportToken}
              className="flex px-3 py-1.5 rounded-xl bg-[#121624] hover:bg-[#1a2033] border border-[#1e2538] text-xs font-mono font-bold text-slate-300 items-center gap-1.5 transition-colors cursor-pointer"
              title={`Import the L3 $xMoney claim token (${CONTRACT_ADDRESSES.XMONEY_USD_L3}) into Rabby / MetaMask`}
            >
              {tokenImported ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Plus className="w-3.5 h-3.5 text-cyan-400" />}
              <span>{tokenImported ? 'Imported!' : '+ L3 $xMoney claim'}</span>
            </button>

            <button
              onClick={toggleSound}
              className="p-2 rounded-xl bg-[#121624] border border-[#1e2538] text-slate-400 hover:text-white transition-colors cursor-pointer"
              title={soundEnabled ? 'Mute Audio' : 'Enable Audio'}
            >
              {soundEnabled ? <Volume2 className="w-4 h-4 text-emerald-400" /> : <VolumeX className="w-4 h-4" />}
            </button>

          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-3 sm:p-5 max-w-[1780px] w-full mx-auto">
        <Hero />
        <div id="play" className="scroll-mt-28 flex gap-1.5 mb-4 overflow-x-auto no-scrollbar [&>*]:shrink-0">
          <button onClick={() => setTab('otc')}
            className={`px-4 py-2 rounded-xl text-xs font-black font-mono uppercase tracking-wide cursor-pointer transition-colors ${tab === 'otc' ? 'bg-emerald-500 text-slate-950' : 'bg-[#121624] border border-[#1e2538] text-slate-400 hover:text-white'}`}>
            OTC desk
          </button>
          <button onClick={() => setTab('mcp')}
            className={`px-4 py-2 rounded-xl text-xs font-black font-mono uppercase tracking-wide cursor-pointer transition-colors ${tab === 'mcp' ? 'bg-emerald-500 text-slate-950' : 'bg-[#121624] border border-[#1e2538] text-slate-400 hover:text-white'}`}>
            MCP connector
          </button>
          <button onClick={() => setTab('ngu')}
            className={`px-4 py-2 rounded-xl text-xs font-black font-mono uppercase tracking-wide cursor-pointer transition-colors ${tab === 'ngu' ? 'bg-emerald-500 text-slate-950' : 'bg-[#121624] border border-[#1e2538] text-slate-400 hover:text-white'}`}>
            NGU launchpad
          </button>
          <button onClick={() => setTab('robinhood')}
            className={`px-4 py-2 rounded-xl text-xs font-black font-mono uppercase tracking-wide cursor-pointer transition-colors ${tab === 'robinhood' ? 'bg-emerald-500 text-slate-950' : 'bg-[#121624] border border-[#1e2538] text-slate-400 hover:text-white'}`}>
            Robinhood desk
          </button>
        </div>
        {tab === 'robinhood' ? (
          <RobinhoodOtc wallet={wallet} onConnectWallet={handleConnectWallet} xHandle={xUser?.handle ?? null} xConfigured={xConfigured} />
        ) : tab === 'mcp' ? (
          <McpConnector />
        ) : tab === 'otc' ? (
          <OrbitXMoneyOtc
            wallet={wallet}
            onConnectWallet={handleConnectWallet}
            xHandle={xUser?.handle ?? null}
          />
        ) : (
          <NguLaunchpad wallet={wallet} onConnectWallet={handleConnectWallet} />
        )}
      </main>
    </div>
  );
}
