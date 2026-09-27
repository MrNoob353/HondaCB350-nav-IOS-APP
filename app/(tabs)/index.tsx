import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import MapView, { Polyline } from 'react-native-maps';

const STORAGE_KEY = '@cb350_trip_history';
const LOGS_STORAGE_KEY = '@cb350_telemetry_logs';

interface TripLog {
  id: string;
  destination: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  totalDistanceKm: string;
  topSpeedKmh: number;
  pointCount: number;
  eventLogs: string[];
}

export default function App() {
  const [ip, setIp] = useState('172.20.10.8');
  const [destination, setDestination] = useState('Kopri, Thane');
  const [waypoints, setWaypoints] = useState<any[]>([]);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [tripLogs, setTripLogs] = useState<TripLog[]>([]);
  const [selectedLog, setSelectedLog] = useState<TripLog | null>(null);

  const [isNavigating, setIsNavigating] = useState(false);
  const [routeCoords, setRouteCoords] = useState<any[]>([]);
  const [steps, setSteps] = useState<any[]>([]);
  const [stepIdx, setStepIdx] = useState(0);
  const [userPos, setUserPos] = useState<any>(null);
  const [totalDistRemaining, setTotalDistRemaining] = useState(0);
  const [logs, setLogs] = useState<string[]>(["[System] Telemetry Ready"]);
  const [initialRegion, setInitialRegion] = useState<any>(null);
  const [isRerouting, setIsRerouting] = useState(false);

  // Active Trip Recording State
  const activeLogRef = useRef<{
    id: string;
    destination: string;
    startTimestamp: number;
    topSpeedKmh: number;
    breadcrumbs: any[];
    events: string[];
    initialDistance: number;
  } | null>(null);

  const scrollRef = useRef<ScrollView>(null);
  const mapRef = useRef<MapView>(null);
  const offRouteCountRef = useRef(0);
  const navTimeoutRef = useRef<any>(null);
  const searchDebounceRef = useRef<any>(null);

  const TURN_MAP: any = {
    'straight': 0, 'slight left': 1, 'left': 1, 'sharp left': 1,
    'slight right': 2, 'right': 2, 'sharp right': 2,
    'uturn': 3, 'arrive': 4, 'roundabout': 5
  };

  useEffect(() => {
    (async () => {
      loadHistoryAndLogs();
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        let loc = await Location.getCurrentPositionAsync({});
        setUserPos(loc.coords);
        setInitialRegion({
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          latitudeDelta: 0.015,
          longitudeDelta: 0.015,
        });
      }
    })();
  }, []);

  // --- STORAGE HELPERS ---
  const loadHistoryAndLogs = async () => {
    try {
      const histData = await AsyncStorage.getItem(STORAGE_KEY);
      if (histData) setHistory(JSON.parse(histData));

      const logData = await AsyncStorage.getItem(LOGS_STORAGE_KEY);
      if (logData) setTripLogs(JSON.parse(logData));
    } catch (e) {}
  };

  const saveTripToHistory = async (destName: string, distMeters: number, stops: any[]) => {
    try {
      const newTrip = {
        id: Date.now().toString(),
        destination: destName,
        distanceKm: (distMeters / 1000).toFixed(1),
        date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
        waypointsCount: stops.length
      };

      const updated = [newTrip, ...history.filter(h => h.destination !== destName)].slice(0, 8);
      setHistory(updated);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch (e) {}
  };

  const finalizeAndSaveTripLog = async () => {
    if (!activeLogRef.current) return;

    const current = activeLogRef.current;
    const endTimestamp = Date.now();
    const durationMin = Math.max(1, Math.round((endTimestamp - current.startTimestamp) / 60000));

    const finalLog: TripLog = {
      id: current.id,
      destination: current.destination,
      startTime: new Date(current.startTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      endTime: new Date(endTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      durationMinutes: durationMin,
      totalDistanceKm: (current.initialDistance / 1000).toFixed(1),
      topSpeedKmh: current.topSpeedKmh,
      pointCount: current.breadcrumbs.length,
      eventLogs: current.events.slice(-10)
    };

    try {
      const updatedLogs = [finalLog, ...tripLogs].slice(0, 15);
      setTripLogs(updatedLogs);
      await AsyncStorage.setItem(LOGS_STORAGE_KEY, JSON.stringify(updatedLogs));
      addLog(`Trip Log Saved: ${finalLog.totalDistanceKm}km in ${durationMin}m`);
    } catch (e) {}

    activeLogRef.current = null;
  };

  const clearLogs = async () => {
    try {
      setTripLogs([]);
      await AsyncStorage.removeItem(LOGS_STORAGE_KEY);
    } catch (e) {}
  };

  const handleSearchTextChange = (text: string) => {
    setDestination(text);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (text.trim().length < 2) {
      setSuggestions([]);
      return;
    }

    searchDebounceRef.current = setTimeout(async () => {
      try {
        let biasParams = '&countrycodes=in&dedupe=1&addressdetails=1';
        if (userPos) {
          const lat = userPos.latitude;
          const lon = userPos.longitude;
          biasParams += `&viewbox=${lon - 1.0},${lat + 1.0},${lon + 1.0},${lat - 1.0}`;
        }

        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(text)}&format=json&limit=6${biasParams}`
        );
        const data = await res.json();
        setSuggestions(data || []);
      } catch (e) {
        setSuggestions([]);
      }
    }, 350);
  };

  const addStop = (item?: any) => {
    if (item) {
      setWaypoints(prev => [...prev, {
        name: item.display_name.split(',')[0],
        lat: parseFloat(item.lat),
        lon: parseFloat(item.lon)
      }]);
      setDestination('');
      setSuggestions([]);
    } else if (destination.trim().length > 0) {
      fetchLocationAndAddStop(destination);
    }
  };

  const fetchLocationAndAddStop = async (query: string) => {
    try {
      let biasParams = '&countrycodes=in&dedupe=1&addressdetails=1';
      if (userPos) {
        biasParams += `&viewbox=${userPos.longitude - 1.0},${userPos.latitude + 1.0},${userPos.longitude + 1.0},${userPos.latitude - 1.0}`;
      }
      const geo = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1${biasParams}`);
      const data = await geo.json();
      if (data.length > 0) {
        setWaypoints(prev => [...prev, {
          name: data[0].display_name.split(',')[0],
          lat: parseFloat(data[0].lat),
          lon: parseFloat(data[0].lon)
        }]);
        setDestination('');
        setSuggestions([]);
      } else {
        addLog("Stop not found");
      }
    } catch (e) {
      addLog("Stop Fetch Error");
    }
  };

  const removeStop = (index: number) => {
    setWaypoints(prev => prev.filter((_, i) => i !== index));
  };

  const selectSuggestion = (item: any) => {
    const shortName = item.display_name.split(',')[0];
    setDestination(shortName);
    setSuggestions([]);
    Keyboard.dismiss();
    startNavWithCoords(parseFloat(item.lat), parseFloat(item.lon), shortName);
  };

  const getArrow = (tc: number) => {
    const arrows: any = { 0: '↑', 1: '←', 2: '→', 3: '⤺', 4: '★', 5: '↺' };
    return arrows[tc] || '•';
  };

  const getFormattedDist = (m: number) => {
    if (m > 5000000 || m <= 0) return "--";
    if (m < 1000) return `${Math.round(m / 5) * 5}m`;
    return `${(m / 1000).toFixed(1)}km`;
  };

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const formatted = `[${time}] ${msg}`;
    setLogs(prev => [...prev, formatted].slice(-15));

    if (activeLogRef.current) {
      activeLogRef.current.events.push(formatted);
    }
  };

  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const fetchOSRMRoute = async (startLat: number, startLon: number, endLat: number, endLon: number) => {
    const coordsString = [
      `${startLon},${startLat}`,
      ...waypoints.map(wp => `${wp.lon},${wp.lat}`),
      `${endLon},${endLat}`
    ].join(';');

    const osrm = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordsString}?steps=true&overview=full&geometries=geojson`);
    const data = await osrm.json();

    if (data.code === 'Ok') {
      const rawSteps: any[] = [];
      data.routes[0].legs.forEach((leg: any) => {
        rawSteps.push(...leg.steps);
      });

      const processedSteps = [];

      for (let i = 0; i < rawSteps.length; i++) {
        const s = rawSteps[i];
        const mod = s.maneuver.modifier || "";
        const type = s.maneuver.type || "";

        let tc = 0;
        if (type.includes('roundabout')) tc = 5;
        else if (mod.includes('uturn') || type.includes('uturn')) tc = 3;
        else if (type === 'arrive') tc = 4;
        else if (TURN_MAP[mod] !== undefined) tc = TURN_MAP[mod];
        else if (mod.includes('left') || type.includes('left')) tc = 1;
        else if (mod.includes('right') || type.includes('right')) tc = 2;

        if (tc !== 0 || s.distance > 25 || type === 'arrive') {
          processedSteps.push({
            tc,
            exit: s.maneuver.exit || 0,
            name: type.includes('roundabout') ? `Exit ${s.maneuver.exit || '?'}` : (s.name || 'Road'),
            lat: s.maneuver.location[1],
            lon: s.maneuver.location[0]
          });
        }
      }

      return {
        totalDist: data.routes[0].distance,
        coords: data.routes[0].geometry.coordinates.map((c: any) => ({ latitude: c[1], longitude: c[0] })),
        steps: processedSteps
      };
    }
    return null;
  };

  const startNavWithCoords = async (destLat: number, destLon: number, name: string) => {
    try {
      const loc = await Location.getCurrentPositionAsync({});
      addLog("Fetching Route...");
      const route = await fetchOSRMRoute(loc.coords.latitude, loc.coords.longitude, destLat, destLon);

      if (route) {
        setTotalDistRemaining(route.totalDist);
        setRouteCoords(route.coords);
        setSteps(route.steps);
        setStepIdx(0);
        setIsNavigating(true);
        offRouteCountRef.current = 0;
        
        // Initialize Active Telemetry Log
        activeLogRef.current = {
          id: Date.now().toString(),
          destination: name,
          startTimestamp: Date.now(),
          topSpeedKmh: 0,
          breadcrumbs: [],
          events: [],
          initialDistance: route.totalDist
        };

        saveTripToHistory(name, route.totalDist, waypoints);
        addLog(`Nav Started (${waypoints.length} stops)`);
        recenterMap();
      }
    } catch (e) {
      addLog("Route Fetch Error");
    }
  };

  const startNav = async () => {
    Keyboard.dismiss();
    setSuggestions([]);
    try {
      const loc = await Location.getCurrentPositionAsync({});
      addLog("Searching location...");
      
      let biasParams = '&countrycodes=in&dedupe=1&addressdetails=1';
      if (userPos) {
        biasParams += `&viewbox=${userPos.longitude - 1.0},${userPos.latitude + 1.0},${userPos.longitude + 1.0},${userPos.latitude - 1.0}`;
      }

      const geo = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(destination)}&format=json&limit=1${biasParams}`);
      const geoData = await geo.json();
      if (!geoData.length) return addLog("Location not found");

      const shortName = geoData[0].display_name.split(',')[0];
      startNavWithCoords(parseFloat(geoData[0].lat), parseFloat(geoData[0].lon), shortName);
    } catch (e) {
      addLog("Network Error");
    }
  };

  const stopNav = async () => {
    await finalizeAndSaveTripLog();
    setIsNavigating(false);
  };

  const recenterMap = async () => {
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      mapRef.current?.animateToRegion({
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        latitudeDelta: 0.015,
        longitudeDelta: 0.015,
      }, 800);
    } catch (e) {
      addLog("Location Error");
    }
  };

  useEffect(() => {
    if (!isNavigating || steps.length === 0) return;
    let isMounted = true;

    const processNavigationTick = async () => {
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        if (!isMounted) return;

        if (loc.coords.accuracy && loc.coords.accuracy <= 30) {
          const lat = loc.coords.latitude;
          const lon = loc.coords.longitude;
          const speedKmh = Math.round((loc.coords.speed || 0) * 3.6);
          setUserPos(loc.coords);

          // Record Breadcrumbs and Top Speed
          if (activeLogRef.current) {
            activeLogRef.current.breadcrumbs.push({ lat, lon, speed: speedKmh });
            if (speedKmh > activeLogRef.current.topSpeedKmh) {
              activeLogRef.current.topSpeedKmh = speedKmh;
            }
          }

          const primary = steps[stepIdx];
          const secondary = steps[stepIdx + 1] || { tc: 0 };
          const distToTurn = Math.round(calculateDistance(lat, lon, primary.lat, primary.lon));

          if (distToTurn < 30 && stepIdx < steps.length - 1) {
            const nextIdx = stepIdx + 1;
            setStepIdx(nextIdx);
            addLog(`Next: ${steps[nextIdx].name}`);
          }

          const formattedDist = getFormattedDist(distToTurn);
          fetch(`http://${ip}/nav`, {
            method: 'POST',
            body: `PT:${primary.tc},D:${formattedDist},ST:${secondary.tc},TOT:${(totalDistRemaining / 1000).toFixed(1)}km`,
            headers: { 'Content-Type': 'text/plain' }
          }).catch(() => {});

          const delay = distToTurn < 80 ? 800 : distToTurn < 300 ? 1500 : 3000;
          navTimeoutRef.current = setTimeout(processNavigationTick, delay);
          return;
        }
      } catch (e) {}

      navTimeoutRef.current = setTimeout(processNavigationTick, 2000);
    };

    processNavigationTick();

    return () => {
      isMounted = false;
      if (navTimeoutRef.current) clearTimeout(navTimeoutRef.current);
    };
  }, [isNavigating, stepIdx, steps, ip, totalDistRemaining]);

  const active = steps[stepIdx];
  const next = steps[stepIdx + 1];

  const getUiDist = () => {
    if (!userPos || !active) return "--";
    const d = calculateDistance(userPos.latitude, userPos.longitude, active.lat, active.lon);
    return getFormattedDist(d);
  };

  return (
    <TouchableWithoutFeedback onPress={() => { Keyboard.dismiss(); setSuggestions([]); }}>
      <View style={styles.container}>
        {initialRegion && (
          <MapView 
            ref={mapRef}
            style={styles.mapBackground}
            initialRegion={initialRegion}
            showsUserLocation={true} 
            followsUserLocation={true}
            userInterfaceStyle="dark"
          >
            {routeCoords.length > 0 && (
              <Polyline coordinates={routeCoords} strokeWidth={6} strokeColor="#8AB4F8" />
            )}
          </MapView>
        )}

        <View style={styles.overlayContainer} pointerEvents="box-none">
          <View style={styles.topSection} pointerEvents="box-none">
            {!isNavigating ? (
              <View style={styles.searchWrapper}>
                {waypoints.length > 0 && (
                  <View style={styles.waypointBadgesRow}>
                    {waypoints.map((wp, idx) => (
                      <View key={idx} style={styles.waypointChip}>
                        <Text style={styles.waypointChipText} numberOfLines={1}>{idx + 1}. {wp.name}</Text>
                        <TouchableOpacity onPress={() => removeStop(idx)}>
                          <Text style={styles.waypointRemoveIcon}>✕</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                )}

                <View style={styles.searchPill}>
                  <Text style={styles.searchIcon}>📍</Text>
                  <TextInput 
                    style={styles.searchInput} 
                    value={destination} 
                    onChangeText={handleSearchTextChange} 
                    placeholder={waypoints.length > 0 ? "Add next stop or destination..." : "Search destination..."} 
                    placeholderTextColor="#9AA0A6" 
                    onSubmitEditing={startNav}
                    returnKeyType="search"
                  />
                  
                  {destination.length > 0 && (
                    <TouchableOpacity style={styles.addStopBtn} onPress={() => addStop()}>
                      <Text style={styles.addStopBtnText}>+ Stop</Text>
                    </TouchableOpacity>
                  )}
                </View>

                {suggestions.length > 0 && (
                  <View style={styles.suggestionsContainer}>
                    {suggestions.map((item, index) => (
                      <View key={index} style={styles.suggestionRow}>
                        <TouchableOpacity 
                          style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}
                          onPress={() => selectSuggestion(item)}
                        >
                          <Text style={styles.suggestionIcon}>📌</Text>
                          <Text style={styles.suggestionText} numberOfLines={1}>
                            {item.display_name}
                          </Text>
                        </TouchableOpacity>
                        
                        <TouchableOpacity 
                          style={styles.suggestionAddStopBtn} 
                          onPress={() => addStop(item)}
                        >
                          <Text style={styles.suggestionAddStopText}>+ Stop</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            ) : (
              active && (
                <View style={styles.navHeader}>
                  <View style={styles.navPrimaryRow}>
                    <Text style={styles.navArrowMain}>{getArrow(active.tc)}</Text>
                    <View style={styles.navTextContainer}>
                      <Text style={styles.navDistText}>{getUiDist()}</Text>
                      <Text style={styles.navRoadText} numberOfLines={1}>{active.name}</Text>
                    </View>
                  </View>
                  {next && (
                    <View style={styles.navSecondaryRow}>
                      <Text style={styles.navSecondaryText}>Then {getArrow(next.tc)}</Text>
                    </View>
                  )}
                </View>
              )
            )}
          </View>

          <KeyboardAvoidingView 
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'} 
            style={styles.bottomSection}
            pointerEvents="box-none"
          >
            <TouchableOpacity style={styles.recenterBtn} onPress={recenterMap} activeOpacity={0.8}>
              <Text style={styles.recenterIcon}>➤</Text>
            </TouchableOpacity>

            <View style={styles.bottomSheet}>
              <View style={styles.dragHandle} />
              
              {!isNavigating ? (
                <View style={styles.sheetContent}>
                  
                  {/* SAVED TRIP LOGS CAROUSEL */}
                  {tripLogs.length > 0 && (
                    <View style={styles.historySection}>
                      <View style={styles.historyHeader}>
                        <Text style={styles.historyTitle}>Recorded Ride Logs</Text>
                        <TouchableOpacity onPress={clearLogs}>
                          <Text style={styles.clearHistoryText}>Clear Logs</Text>
                        </TouchableOpacity>
                      </View>

                      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.historyScroll}>
                        {tripLogs.map((log) => (
                          <TouchableOpacity 
                            key={log.id} 
                            style={styles.logCard}
                            onPress={() => setSelectedLog(log)}
                            activeOpacity={0.7}
                          >
                            <Text style={styles.historyCardTitle} numberOfLines={1}>{log.destination}</Text>
                            <Text style={styles.logCardStats}>{log.totalDistanceKm} km • {log.durationMinutes} mins</Text>
                            <Text style={styles.logCardSub}>Top: {log.topSpeedKmh} km/h</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </View>
                  )}

                  <Text style={styles.sheetTitle}>Hardware Connect</Text>
                  <TextInput 
                    style={styles.sheetInput} 
                    value={ip} 
                    onChangeText={setIp} 
                    keyboardType="decimal-pad" 
                    placeholder="ESP32 IP Address" 
                    placeholderTextColor="#9AA0A6" 
                  />
                  <TouchableOpacity style={styles.googleBtn} onPress={startNav} activeOpacity={0.8}>
                    <Text style={styles.googleBtnText}>
                      {waypoints.length > 0 ? `Start Route (${waypoints.length + 1} Stops)` : "Start Navigation"}
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.sheetContentRow}>
                  <View>
                    <Text style={styles.tripRemainingText}>{(totalDistRemaining / 1000).toFixed(1)} km</Text>
                    <Text style={styles.tripSubText}>{isRerouting ? "Recalculating..." : "Remaining distance"}</Text>
                  </View>
                  <TouchableOpacity style={styles.exitBtn} onPress={stopNav} activeOpacity={0.8}>
                    <Text style={styles.exitBtnText}>Exit</Text>
                  </TouchableOpacity>
                </View>
              )}

              <View style={styles.terminal}>
                <ScrollView ref={scrollRef} onContentSizeChange={() => scrollRef.current?.scrollToEnd()}>
                  {logs.map((l, i) => <Text key={i} style={styles.logText}>{l}</Text>)}
                </ScrollView>
              </View>
            </View>
          </KeyboardAvoidingView>

          {/* TELEMETRY LOG DETAIL MODAL */}
          {selectedLog && (
            <Modal animationType="slide" transparent={true} visible={!!selectedLog}>
              <View style={styles.modalOverlay}>
                <View style={styles.modalContent}>
                  <View style={styles.modalHeader}>
                    <Text style={styles.modalTitle}>{selectedLog.destination}</Text>
                    <TouchableOpacity onPress={() => setSelectedLog(null)}>
                      <Text style={styles.modalCloseIcon}>✕</Text>
                    </TouchableOpacity>
                  </View>

                  <View style={styles.modalGrid}>
                    <View style={styles.modalGridItem}>
                      <Text style={styles.modalGridValue}>{selectedLog.totalDistanceKm} km</Text>
                      <Text style={styles.modalGridLabel}>Distance</Text>
                    </View>
                    <View style={styles.modalGridItem}>
                      <Text style={styles.modalGridValue}>{selectedLog.durationMinutes} min</Text>
                      <Text style={styles.modalGridLabel}>Duration</Text>
                    </View>
                    <View style={styles.modalGridItem}>
                      <Text style={styles.modalGridValue}>{selectedLog.topSpeedKmh} km/h</Text>
                      <Text style={styles.modalGridLabel}>Top Speed</Text>
                    </View>
                  </View>

                  <Text style={styles.modalSubHeader}>Event Trail ({selectedLog.startTime} - {selectedLog.endTime})</Text>
                  <ScrollView style={styles.modalLogsContainer}>
                    {selectedLog.eventLogs.map((evt, idx) => (
                      <Text key={idx} style={styles.modalLogText}>{evt}</Text>
                    ))}
                  </ScrollView>
                </View>
              </View>
            </Modal>
          )}

        </View>
      </View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  mapBackground: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' },
  overlayContainer: { flex: 1, justifyContent: 'space-between' },
  topSection: { paddingHorizontal: 12, paddingTop: Platform.OS === 'ios' ? 40 : 20 },
  
  searchWrapper: { width: '100%' },
  waypointBadgesRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  waypointChip: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(138, 180, 248, 0.25)',
    paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, borderColor: '#8AB4F8'
  },
  waypointChipText: { color: '#8AB4F8', fontSize: 12, fontWeight: '600', maxWidth: 120 },
  waypointRemoveIcon: { color: '#8AB4F8', fontSize: 12, marginLeft: 6, fontWeight: 'bold' },

  searchPill: { 
    flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(48, 49, 52, 0.85)',
    borderRadius: 24, paddingHorizontal: 14, paddingVertical: 10, shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 8, elevation: 5
  },
  searchIcon: { fontSize: 18, marginRight: 10, opacity: 0.8 },
  searchInput: { flex: 1, color: '#E8EAED', fontSize: 16, fontWeight: '400', padding: 0 },
  
  addStopBtn: { backgroundColor: '#3C4043', paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12, marginLeft: 8 },
  addStopBtnText: { color: '#8AB4F8', fontSize: 12, fontWeight: '700' },

  suggestionsContainer: {
    backgroundColor: 'rgba(32, 33, 36, 0.95)', borderRadius: 16, marginTop: 6,
    paddingVertical: 6, overflow: 'hidden', borderWidth: 1, borderColor: '#3C4043'
  },
  suggestionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 14 },
  suggestionIcon: { fontSize: 14, marginRight: 10 },
  suggestionText: { color: '#E8EAED', fontSize: 14, flex: 1 },
  suggestionAddStopBtn: { backgroundColor: 'rgba(138, 180, 248, 0.15)', paddingVertical: 4, paddingHorizontal: 8, borderRadius: 8, marginLeft: 8 },
  suggestionAddStopText: { color: '#8AB4F8', fontSize: 11, fontWeight: '700' },

  navHeader: { 
    backgroundColor: 'rgba(30, 62, 43, 0.5)', borderRadius: 16, padding: 12, shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 8, elevation: 6
  },
  navPrimaryRow: { flexDirection: 'row', alignItems: 'center' },
  navArrowMain: { fontSize: 38, color: '#FFF', marginRight: 12, fontWeight: '800' },
  navTextContainer: { flex: 1, justifyContent: 'center' },
  navDistText: { color: '#FFF', fontSize: 26, fontWeight: '800' },
  navRoadText: { color: '#E8EAED', fontSize: 16, fontWeight: '500', marginTop: 0 },
  navSecondaryRow: { marginTop: 8, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.2)', paddingTop: 8 },
  navSecondaryText: { color: '#E8EAED', fontSize: 14, fontWeight: '600' },
  bottomSection: { width: '100%', position: 'relative' },
  recenterBtn: {
    position: 'absolute', right: 12, top: -55, backgroundColor: 'rgba(48, 49, 52, 0.85)',
    width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 6, elevation: 6, zIndex: 10
  },
  recenterIcon: { color: '#8AB4F8', fontSize: 20, transform: [{ rotate: '-45deg' }], marginLeft: -1, marginTop: -1 },
  bottomSheet: {
    backgroundColor: 'rgba(32, 33, 36, 0.85)', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 16, paddingBottom: Platform.OS === 'ios' ? 25 : 15, paddingTop: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.3, shadowRadius: 10, elevation: 15
  },
  dragHandle: { width: 36, height: 4, backgroundColor: '#5F6368', borderRadius: 2, alignSelf: 'center', marginBottom: 12 },
  
  historySection: { marginBottom: 12 },
  historyHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  historyTitle: { color: '#E8EAED', fontSize: 14, fontWeight: '600' },
  clearHistoryText: { color: '#9AA0A6', fontSize: 12, fontWeight: '500' },
  historyScroll: { flexDirection: 'row', marginHorizontal: -4 },
  
  logCard: {
    backgroundColor: 'rgba(48, 49, 52, 0.8)', paddingVertical: 8, paddingHorizontal: 12,
    borderRadius: 12, marginRight: 8, maxWidth: 150, borderWidth: 1, borderColor: '#34A853'
  },
  historyCardTitle: { color: '#E8EAED', fontSize: 13, fontWeight: '600' },
  logCardStats: { color: '#8AB4F8', fontSize: 11, fontWeight: '600', marginTop: 2 },
  logCardSub: { color: '#9AA0A6', fontSize: 10, marginTop: 1 },

  sheetContent: { width: '100%' },
  sheetTitle: { color: '#E8EAED', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  sheetInput: { backgroundColor: 'rgba(48, 49, 52, 0.8)', color: '#E8EAED', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, fontSize: 15, marginBottom: 12 },
  googleBtn: { backgroundColor: '#8AB4F8', paddingVertical: 12, borderRadius: 20, alignItems: 'center' },
  googleBtnText: { color: '#202124', fontWeight: '700', fontSize: 15 },
  sheetContentRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  tripRemainingText: { color: '#34A853', fontSize: 20, fontWeight: '800' },
  tripSubText: { color: '#9AA0A6', fontSize: 12, fontWeight: '500' },
  exitBtn: { backgroundColor: '#EA4335', paddingVertical: 8, paddingHorizontal: 20, borderRadius: 20 },
  exitBtnText: { color: '#FFF', fontWeight: '700', fontSize: 14 },
  terminal: { height: 50, backgroundColor: 'rgba(23, 23, 23, 0.5)', borderRadius: 8, padding: 6, marginTop: 10 },
  logText: { color: '#81C995', fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginBottom: 1 },

  // MODAL STYLES
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#202124', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, maxHeight: '60%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { color: '#E8EAED', fontSize: 18, fontWeight: '700' },
  modalCloseIcon: { color: '#9AA0A6', fontSize: 18, padding: 4 },
  modalGrid: { flexDirection: 'row', justifyContent: 'space-around', backgroundColor: '#303134', borderRadius: 12, padding: 12, marginBottom: 16 },
  modalGridItem: { alignItems: 'center' },
  modalGridValue: { color: '#8AB4F8', fontSize: 18, fontWeight: '800' },
  modalGridLabel: { color: '#9AA0A6', fontSize: 11, marginTop: 2 },
  modalSubHeader: { color: '#E8EAED', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  modalLogsContainer: { backgroundColor: '#171717', borderRadius: 8, padding: 10, maxHeight: 150 },
  modalLogText: { color: '#81C995', fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginBottom: 4 }
});