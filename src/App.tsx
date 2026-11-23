import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { ImmersoProvider, useImmerso } from './context/ImmersoContext.tsx';
import { Navbar } from './components/Navbar.tsx';
import { HeroSection } from './components/HeroSection.tsx';
import { ShopSection } from './components/ShopSection.tsx';
import { ProductDetailModal } from './components/ProductDetailModal.tsx';
import { CartDrawer } from './components/CartDrawer.tsx';
import { CheckoutModal } from './components/CheckoutModal.tsx';
import { FloatingChatbot } from './components/FloatingChatbot.tsx';
import { AiStylistPage } from './components/AiStylistPage.tsx';
import { WardrobePage } from './components/WardrobePage.tsx';
import { OutfitGeneratorPage } from './components/OutfitGeneratorPage.tsx';
import { VirtualTryOnPage } from './components/VirtualTryOnPage.tsx';
import { OutfitPlannerPage } from './components/OutfitPlannerPage.tsx';
import { StyleInspirationPage } from './components/StyleInspirationPage.tsx';
import { OrderTrackingPage } from './components/OrderTrackingPage.tsx';
import { UserDashboardPage } from './components/UserDashboardPage.tsx';
import { AdminDashboardPage } from './components/AdminDashboardPage.tsx';
import { AdminLoginPage } from './components/AdminLoginPage.tsx';
import {
  AboutPage,
  ContactPage,
  FaqPage,
  PolicyPage,
  SubscriptionsPage,
} from './components/SupportAndInfoPages.tsx';
import { Footer } from './components/Footer.tsx';

function ToastStack() {
  const { toasts } = useImmerso();
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-20 right-4 z-50 space-y-2 max-w-xs w-full pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`px-4 py-3 rounded-xl text-xs font-medium shadow-lg border backdrop-blur-md ${
            t.tone === 'error'
              ? 'bg-red-950/90 text-white border-red-700'
              : t.tone === 'success'
              ? 'bg-[#2A231E]/95 text-[#FDFBF7] border-[#B5945B]/60'
              : 'bg-white/95 text-[#2A231E] border-[#E5DDD0]'
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

function ImmersoShell() {
  const { currentPage, isAdmin, adminAuthReady } = useImmerso();

  const renderPage = () => {
    switch (currentPage) {
      case 'home':
        return (
          <>
            <HeroSection />
            <ShopSection previewOnly />
            <StyleInspirationPage previewOnly />
          </>
        );
      case 'shop':
      case 'collections':
        return <ShopSection />;
      case 'ai-stylist':
        return <AiStylistPage />;
      case 'wardrobe':
        return <WardrobePage />;
      case 'planner':
        return <OutfitPlannerPage />;
      case 'outfit-generator':
        return <OutfitGeneratorPage />;
      case 'virtual-tryon':
        return <VirtualTryOnPage />;
      case 'inspiration':
        return <StyleInspirationPage />;
      case 'order-tracking':
        return <OrderTrackingPage />;
      case 'dashboard':
        return <UserDashboardPage />;
      case 'admin-login':
        return <AdminLoginPage />;
      case 'admin':
        return adminAuthReady && isAdmin ? <AdminDashboardPage /> : <AdminLoginPage />;
      case 'subscriptions':
        return <SubscriptionsPage />;
      case 'about':
        return <AboutPage />;
      case 'contact':
        return <ContactPage />;
      case 'faq':
        return <FaqPage />;
      case 'privacy':
        return <PolicyPage type="privacy" />;
      case 'terms':
        return <PolicyPage type="terms" />;
      case 'shipping':
        return <PolicyPage type="shipping" />;
      case 'returns':
        return <PolicyPage type="returns" />;
      default:
        return <HeroSection />;
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#FDFBF7] text-[#2A231E]">
      <Navbar />
      <main className="flex-1">{renderPage()}</main>
      <Footer />
      <ProductDetailModal />
      <CartDrawer />
      <CheckoutModal />
      <FloatingChatbot />
      <ToastStack />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ImmersoProvider>
        <ImmersoShell />
      </ImmersoProvider>
    </ErrorBoundary>
  );
}
