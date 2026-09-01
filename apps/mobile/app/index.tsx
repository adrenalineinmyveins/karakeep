import { Redirect } from "expo-router";

// Dev stage: skip the sign-in gate and always land on the dashboard.
export default function App() {
  return <Redirect href="dashboard" />;
}
