import { Tabs } from 'expo-router';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // Completely hides the bottom navigation bar
        tabBarStyle: { display: 'none' },
      }}>
      
      {/* 1. Main Map (Single Screen) */}
      <Tabs.Screen name="index" />

    </Tabs>
  );
}