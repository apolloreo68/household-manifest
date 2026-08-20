import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Home, Warehouse, Plus, X, Search, User, Package, Sofa, Palette,
  UtensilsCrossed, Dumbbell, Shirt, BookOpen, Tv, Wrench, Box,
  Trash2, Edit3, Tag, Loader2, AlertCircle, Check, Camera,
  LogOut, Mail, Lock, Image as ImageIcon, ImageOff, ChevronDown, ChevronRight, ChevronLeft,
  ClipboardList, ArrowRight, CheckCircle2, MapPin
} from "lucide-react";
import { db, auth } from "./firebase";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { DndContext, PointerSensor, TouchSensor, useSensor, useSensors, closestCenter } from "@dnd-kit/core";
import { SortableContext, useSortable, rectSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// All family data lives in a single Firestore document. Every device that
// has this app open gets pushed live updates via onSnapshot.
const MANIFEST_DOC = doc(db, "manifest", "household");

const TILE_COLORS = ["#E8834A", "#8B5FA3", "#C1583F", "#7C8B6F", "#B8763F", "#6E7CA8", "#A85B7C", "#5F9E82"];

const uid = () => Math.random().toString(36).slice(2, 10);
const emptyData = () => ({ properties: [], people: [], categories: [], items: [], tasks: [] });

function categoryIcon(name = "") {
  const n = name.toLowerCase();
  if (n.includes("furnit")) return Sofa;
  if (n.includes("art")) return Palette;
  if (n.includes("kitchen") || n.includes("dish") || n.includes("cook")) return UtensilsCrossed;
  if (n.includes("sport") || n.includes("gym") || n.includes("fitness")) return Dumbbell;
  if (n.includes("cloth") || n.includes("apparel") || n.includes("linen")) return Shirt;
  if (n.includes("book") || n.includes("document")) return BookOpen;
  if (n.includes("electronic") || n.includes("tech") || n.includes("appliance")) return Tv;
  if (n.includes("tool") || n.includes("garage") || n.includes("hardware")) return Wrench;
  return Package;
}

// Shrinks a photo down before it's stored, since Firestore documents have a
// size limit and we're keeping everything in one document. Resizes to a max
// width and re-encodes as a compressed JPEG.
// Shrinks a photo down before it's stored, since Firestore documents have a
// size limit and we're keeping everything in one document. Resizes to a max
// width and re-encodes as a compressed JPEG. Tries the modern, fast
// createImageBitmap path first (works straight off the File, no giant base64
// string in the middle) and falls back to the older Image-element approach
// for any browser/file that path can't handle.
async function compressImageFile(file, maxWidth = 640, quality = 0.7) {
  if (!file.type || !file.type.startsWith("image/")) {
    throw new Error("That doesn't look like an image file.");
  }
  if (file.size > 25 * 1024 * 1024) {
    throw new Error("That photo is too large (over 25MB).");
  }

  let source;
  let width, height;
  try {
    source = await createImageBitmap(file);
    width = source.width;
    height = source.height;
  } catch (err) {
    source = await loadImageElement(file);
    width = source.naturalWidth || source.width;
    height = source.naturalHeight || source.height;
  }

  const scale = Math.min(1, maxWidth / width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not available in this browser.");
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (source.close) source.close();
  return canvas.toDataURL("image/jpeg", quality);
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not read image"));
      img.onload = () => resolve(img);
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function useDebouncedSave(data, ready) {
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => {
      setDoc(MANIFEST_DOC, data).catch((e) => console.error("save failed", e));
    }, 350);
    return () => clearTimeout(t);
  }, [data, ready]);
}

export default function App() {
  const [authUser, setAuthUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [data, setData] = useState(emptyData());
  const [ready, setReady] = useState(false);

  // view: 'home' | 'property' | 'category' | 'globalCategory' | 'room'
  const [view, setView] = useState("home");
  const [selectedPropertyId, setSelectedPropertyId] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState(null); // "" means uncategorized
  const [selectedRoom, setSelectedRoom] = useState(null); // "" means no location set

  const [homeSearch, setHomeSearch] = useState("");

  const [propertyModal, setPropertyModal] = useState(null); // { mode:'create'|'edit', property? }
  const [categoryModal, setCategoryModal] = useState(null); // { mode, category? }
  const [roomModal, setRoomModal] = useState(null); // { mode, room? }
  const [peopleModal, setPeopleModal] = useState(false);
  const [itemModal, setItemModal] = useState(null); // { mode, item? }
  const [itemDetail, setItemDetail] = useState(null); // the item currently shown in the detail popup
  const [taskModal, setTaskModal] = useState(null); // { mode, task? }
  const [taskDetail, setTaskDetail] = useState(null); // id of the task currently shown in the detail popup
  const [confirmDelete, setConfirmDelete] = useState(null); // { type, id, label }
  const [whoAreYouOpen, setWhoAreYouOpen] = useState(false);

  // Wire the phone/browser back button (and gesture) to step back through
  // the app's own screens instead of exiting straight out of the page.
  const pushView = (next) => {
    const state = {
      view: next.view,
      selectedPropertyId: next.selectedPropertyId ?? null,
      selectedCategory: next.selectedCategory ?? null,
      selectedRoom: next.selectedRoom ?? null,
    };
    window.history.pushState(state, "");
    setView(state.view);
    setSelectedPropertyId(state.selectedPropertyId);
    setSelectedCategory(state.selectedCategory);
    setSelectedRoom(state.selectedRoom);
  };

  const closeAllModals = () => {
    setPropertyModal(null);
    setCategoryModal(null);
    setRoomModal(null);
    setPeopleModal(false);
    setItemModal(null);
    setItemDetail(null);
    setTaskModal(null);
    setTaskDetail(null);
    setConfirmDelete(null);
    setWhoAreYouOpen(false);
  };

  const anyModalOpen = !!(
    propertyModal || categoryModal || roomModal || peopleModal || itemModal || itemDetail ||
    taskModal || taskDetail || confirmDelete || whoAreYouOpen
  );
  const modalHistoryRef = useRef(false);

  // Any popup counts as its own "screen" for back-button purposes: opening
  // one adds a history entry, and closing it — whether by tapping its own X
  // button or by pressing the phone's back button — steps back exactly one
  // entry, so back never skips straight past a popup and out of the app.
  useEffect(() => {
    if (anyModalOpen && !modalHistoryRef.current) {
      window.history.pushState({ modalOpen: true }, "");
      modalHistoryRef.current = true;
    } else if (!anyModalOpen && modalHistoryRef.current) {
      modalHistoryRef.current = false;
      window.history.back();
    }
  }, [anyModalOpen]);

  useEffect(() => {
    window.history.replaceState({ view: "home", selectedPropertyId: null, selectedCategory: null, selectedRoom: null }, "");
    const onPopState = (e) => {
      if (modalHistoryRef.current) {
        modalHistoryRef.current = false;
        closeAllModals();
        return;
      }
      const s = e.state || { view: "home", selectedPropertyId: null, selectedCategory: null, selectedRoom: null };
      setView(s.view);
      setSelectedPropertyId(s.selectedPropertyId);
      setSelectedCategory(s.selectedCategory);
      setSelectedRoom(s.selectedRoom ?? null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setAuthUser(u);
      setAuthChecked(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    // Only listen once someone's signed in — the security rules require it,
    // and there's no point paying for a listener nobody's allowed to read.
    if (!authUser) { setReady(false); return; }
    const unsubscribe = onSnapshot(
      MANIFEST_DOC,
      (snap) => {
        if (snap.exists()) setData({ ...emptyData(), ...snap.data() });
        setReady(true);
      },
      (err) => {
        console.error("listen failed", err);
        setReady(true);
      }
    );
    return () => unsubscribe();
  }, [authUser]);

  useDebouncedSave(data, ready && !!authUser);

  const properties = data.properties;
  const people = data.people;
  const categories = data.categories;
  const items = data.items;
  const userLinks = data.userLinks || {}; // { [firebase uid]: personId }
  const myPersonId = authUser ? userLinks[authUser.uid] : null;

  useEffect(() => {
    // Ask "which family member are you?" once per account, after data has
    // loaded, if this signed-in account isn't linked to anyone yet.
    if (ready && authUser && !myPersonId) setWhoAreYouOpen(true);
  }, [ready, authUser, myPersonId]);

  const linkMeToPerson = (personId) => {
    if (!authUser) return;
    setData((d) => ({ ...d, userLinks: { ...(d.userLinks || {}), [authUser.uid]: personId } }));
    setWhoAreYouOpen(false);
  };

  const selectedProperty = properties.find((p) => p.id === selectedPropertyId) || null;

  const itemCountForProperty = (propertyId) => items.filter((it) => it.propertyId === propertyId).length;
  const itemCountForCategory = (propertyId, cat) =>
    items.filter((it) => it.propertyId === propertyId && (it.category || "") === (cat || "")).length;
  const itemCountForCategoryGlobal = (cat) => items.filter((it) => (it.category || "") === (cat || "")).length;
  const hasGlobalUncategorized = items.some((it) => !it.category);
  const itemCountForRoom = (propertyId, room) =>
    items.filter((it) => it.propertyId === propertyId && (it.location || "") === (room || "")).length;

  const categoriesInProperty = useMemo(() => {
    if (!selectedPropertyId) return { list: [], hasUncategorized: false };
    const hasUncategorized = items.some((it) => it.propertyId === selectedPropertyId && !it.category);
    return { list: categories, hasUncategorized };
  }, [items, categories, selectedPropertyId]);

  const roomsInProperty = useMemo(() => {
    if (!selectedPropertyId) return { list: [], hasNoRoom: false };
    const property = properties.find((p) => p.id === selectedPropertyId);
    const hasNoRoom = items.some((it) => it.propertyId === selectedPropertyId && !it.location);
    return { list: property?.rooms || [], hasNoRoom };
  }, [items, properties, selectedPropertyId]);

  const currentItems = useMemo(() => {
    if (view === "category" && selectedPropertyId) {
      return items.filter(
        (it) => it.propertyId === selectedPropertyId && (it.category || "") === (selectedCategory || "")
      );
    }
    if (view === "globalCategory") {
      return items.filter((it) => (it.category || "") === (selectedCategory || ""));
    }
    if (view === "room" && selectedPropertyId) {
      return items.filter(
        (it) => it.propertyId === selectedPropertyId && (it.location || "") === (selectedRoom || "")
      );
    }
    return [];
  }, [items, view, selectedPropertyId, selectedCategory, selectedRoom]);

  const homeSearchResults = useMemo(() => {
    if (!homeSearch.trim()) return null;
    const q = homeSearch.trim().toLowerCase();
    return items.filter((it) => {
      const hay = [it.name, it.category, it.notes, ...(it.customFields || []).flatMap((f) => [f.key, f.value])]
        .join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [items, homeSearch]);

  const personName = (id) => people.find((p) => p.id === id)?.name || null;
  const propertyName = (id) => properties.find((p) => p.id === id)?.name || "Unknown";

  /* ---- mutations ---- */
  const saveProperty = (name, type, id) => {
    setData((d) => {
      if (id) return { ...d, properties: d.properties.map((p) => (p.id === id ? { ...p, name, type } : p)) };
      return { ...d, properties: [...d.properties, { id: uid(), name, type, rooms: [] }] };
    });
  };
  const deleteProperty = (id) => {
    setData((d) => ({
      ...d,
      properties: d.properties.filter((p) => p.id !== id),
      items: d.items.filter((it) => it.propertyId !== id),
    }));
    if (selectedPropertyId === id) pushView({ view: "home" });
  };

  const saveCategory = (name, oldName) => {
    setData((d) => {
      if (oldName !== undefined) {
        return {
          ...d,
          categories: d.categories.map((c) => (c.name === oldName ? { ...c, name } : c)),
          items: d.items.map((it) => (it.category === oldName ? { ...it, category: name } : it)),
        };
      }
      if (d.categories.some((c) => c.name === name)) return d;
      return { ...d, categories: [...d.categories, { name, subcategories: [] }] };
    });
  };
  const deleteCategory = (name) => {
    setData((d) => ({
      ...d,
      categories: d.categories.filter((c) => c.name !== name),
      items: d.items.map((it) => (it.category === name ? { ...it, category: "", subcategory: "" } : it)),
    }));
    if (selectedCategory === name) pushView(selectedPropertyId ? { view: "property", selectedPropertyId } : { view: "home" });
  };

  const saveSubcategory = (parentName, subName, oldSubName) => {
    setData((d) => ({
      ...d,
      categories: d.categories.map((c) => {
        if (c.name !== parentName) return c;
        const subs = c.subcategories || [];
        if (oldSubName !== undefined) {
          return { ...c, subcategories: subs.map((s) => (s === oldSubName ? subName : s)) };
        }
        if (subs.includes(subName)) return c;
        return { ...c, subcategories: [...subs, subName] };
      }),
      items: oldSubName !== undefined
        ? d.items.map((it) => (it.category === parentName && it.subcategory === oldSubName ? { ...it, subcategory: subName } : it))
        : d.items,
    }));
  };
  const deleteSubcategory = (parentName, subName) => {
    setData((d) => ({
      ...d,
      categories: d.categories.map((c) => (
        c.name === parentName ? { ...c, subcategories: (c.subcategories || []).filter((s) => s !== subName) } : c
      )),
      items: d.items.map((it) => (
        it.category === parentName && it.subcategory === subName ? { ...it, subcategory: "" } : it
      )),
    }));
  };

  const saveRoom = (propertyId, name, oldName) => {
    setData((d) => ({
      ...d,
      properties: d.properties.map((p) => {
        if (p.id !== propertyId) return p;
        const rooms = p.rooms || [];
        if (oldName !== undefined) {
          return { ...p, rooms: rooms.map((r) => (r === oldName ? name : r)) };
        }
        if (rooms.includes(name)) return p;
        return { ...p, rooms: [...rooms, name] };
      }),
      items: oldName !== undefined
        ? d.items.map((it) => (it.propertyId === propertyId && it.location === oldName ? { ...it, location: name } : it))
        : d.items,
    }));
  };
  const deleteRoom = (propertyId, name) => {
    setData((d) => ({
      ...d,
      properties: d.properties.map((p) => (
        p.id === propertyId ? { ...p, rooms: (p.rooms || []).filter((r) => r !== name) } : p
      )),
      items: d.items.map((it) => (
        it.propertyId === propertyId && it.location === name ? { ...it, location: "" } : it
      )),
    }));
    if (selectedRoom === name) pushView({ view: "property", selectedPropertyId: propertyId });
  };

  // Drag-and-drop reordering: houses and storage spots are reordered within
  // their own subset of the properties array (dragging a house never moves a
  // storage entry), categories reorder directly.
  const reorderProperties = (type, activeId, overId) => {
    if (activeId === overId) return;
    setData((d) => {
      const subset = d.properties.filter((p) => p.type === type);
      const oldIndex = subset.findIndex((p) => p.id === activeId);
      const newIndex = subset.findIndex((p) => p.id === overId);
      if (oldIndex === -1 || newIndex === -1) return d;
      const reordered = arrayMove(subset, oldIndex, newIndex);
      let ptr = 0;
      const newProperties = d.properties.map((p) => (p.type === type ? reordered[ptr++] : p));
      return { ...d, properties: newProperties };
    });
  };
  const reorderCategories = (activeName, overName) => {
    if (activeName === overName) return;
    setData((d) => {
      const oldIndex = d.categories.findIndex((c) => c.name === activeName);
      const newIndex = d.categories.findIndex((c) => c.name === overName);
      if (oldIndex === -1 || newIndex === -1) return d;
      return { ...d, categories: arrayMove(d.categories, oldIndex, newIndex) };
    });
  };

  const savePerson = (name, id) => {
    setData((d) => {
      if (id) return { ...d, people: d.people.map((p) => (p.id === id ? { ...p, name } : p)) };
      return { ...d, people: [...d.people, { id: uid(), name }] };
    });
  };
  const deletePerson = (id) => {
    setData((d) => ({
      ...d,
      people: d.people.filter((p) => p.id !== id),
      items: d.items.map((it) => (
        it.loanedTo === id ? { ...it, status: "storage", loanedTo: null } : it
      )),
    }));
  };

  const upsertItem = (item) => {
    setData((d) => ({
      ...d,
      categories: item.category && !d.categories.some((c) => c.name === item.category)
        ? [...d.categories, { name: item.category, subcategories: item.subcategory ? [item.subcategory] : [] }]
        : (item.category && item.subcategory
          ? d.categories.map((c) => (
              c.name === item.category && !(c.subcategories || []).includes(item.subcategory)
                ? { ...c, subcategories: [...(c.subcategories || []), item.subcategory] }
                : c
            ))
          : d.categories),
      properties: item.location
        ? d.properties.map((p) => (
            p.id === item.propertyId && !(p.rooms || []).includes(item.location)
              ? { ...p, rooms: [...(p.rooms || []), item.location] }
              : p
          ))
        : d.properties,
      items: d.items.some((it) => it.id === item.id) ? d.items.map((it) => (it.id === item.id ? item : it)) : [...d.items, item],
    }));
  };
  const deleteItem = (id) => setData((d) => ({ ...d, items: d.items.filter((it) => it.id !== id) }));

  const upsertTask = (task) => {
    setData((d) => ({
      ...d,
      tasks: (d.tasks || []).some((t) => t.id === task.id)
        ? d.tasks.map((t) => (t.id === task.id ? task : t))
        : [...(d.tasks || []), task],
    }));
  };
  const deleteTask = (id) => setData((d) => ({ ...d, tasks: (d.tasks || []).filter((t) => t.id !== id) }));
  const completeTask = (task) => {
    setData((d) => ({
      ...d,
      items: d.items.map((it) => (task.itemIds.includes(it.id) ? { ...it, propertyId: task.destinationPropertyId } : it)),
      tasks: (d.tasks || []).filter((t) => t.id !== task.id),
    }));
    setTaskDetail(null);
  };

  if (!authChecked) {
    return (
      <div style={styles.loadingScreen}>
        <GlobalStyle />
        <Loader2 className="spin" size={28} color="#E8834A" />
        <div style={{ marginTop: 12, fontFamily: FONT_BODY, color: "#8A8577" }}>Checking your sign-in…</div>
      </div>
    );
  }

  if (!authUser) {
    return (
      <div style={styles.app}>
        <GlobalStyle />
        <LoginScreen />
      </div>
    );
  }

  if (!ready) {
    return (
      <div style={styles.loadingScreen}>
        <GlobalStyle />
        <Loader2 className="spin" size={28} color="#E8834A" />
        <div style={{ marginTop: 12, fontFamily: FONT_BODY, color: "#8A8577" }}>Opening MyStuff…</div>
      </div>
    );
  }

  return (
    <div style={styles.app}>
      <GlobalStyle />

      <header style={styles.header}>
        <div style={styles.brand}>
          {view !== "home" && (
            <button
              style={styles.backBtn}
              onClick={() => window.history.back()}
              title="Back"
            >
              <ChevronLeft size={18} />
            </button>
          )}
          <div style={styles.brandMark}>⌂</div>
          <div>
            <div style={styles.brandTitle}>MyStuff</div>
            {view !== "home" && (
              <Breadcrumb
                property={selectedProperty}
                category={(view === "category" || view === "globalCategory") ? selectedCategory : null}
                room={view === "room" ? selectedRoom : null}
                onHome={() => pushView({ view: "home" })}
                onProperty={() => pushView({ view: "property", selectedPropertyId })}
              />
            )}
          </div>
        </div>
        <div style={styles.headerActions}>
          {view === "home" && (
            <div style={styles.searchBox}>
              <Search size={14} color="#9C8468" />
              <input
                value={homeSearch}
                onChange={(e) => setHomeSearch(e.target.value)}
                placeholder="Search every item…"
                style={styles.searchInput}
              />
            </div>
          )}
          {view === "home" && (
            <button style={styles.secondaryBtn} onClick={() => setPeopleModal(true)}>
              <User size={14} /> People
            </button>
          )}
          <button style={styles.secondaryBtn} onClick={() => signOut(auth)} title="Sign out">
            <LogOut size={14} />
          </button>
        </div>
      </header>

      <main style={styles.main}>
        {view === "home" && homeSearchResults ? (
          <SearchResultsView
            results={homeSearchResults}
            propertyName={propertyName}
            onOpenItem={(it) => setItemDetail(it.id)}
          />
        ) : view === "home" ? (
          <HomeView
            properties={properties}
            categories={categories}
            itemCountForProperty={itemCountForProperty}
            itemCountForCategoryGlobal={itemCountForCategoryGlobal}
            hasGlobalUncategorized={hasGlobalUncategorized}
            onOpen={(id) => pushView({ view: "property", selectedPropertyId: id })}
            onEdit={(p) => setPropertyModal({ mode: "edit", property: p })}
            onDelete={(p) => setConfirmDelete({ type: "property", id: p.id, label: p.name })}
            onAdd={() => setPropertyModal({ mode: "create" })}
            onOpenGlobalCategory={(cat) => pushView({ view: "globalCategory", selectedCategory: cat })}
            onAddCategory={() => setCategoryModal({ mode: "create" })}
            onReorderProperties={reorderProperties}
            onReorderCategories={reorderCategories}
          />
        ) : view === "property" ? (
          <PropertyView
            property={selectedProperty}
            categories={categoriesInProperty.list}
            hasUncategorized={categoriesInProperty.hasUncategorized}
            itemCountForCategory={(cat) => itemCountForCategory(selectedPropertyId, cat)}
            onOpenCategory={(cat) => pushView({ view: "category", selectedPropertyId, selectedCategory: cat })}
            onEditCategory={(cat) => setCategoryModal({ mode: "edit", category: cat })}
            onDeleteCategory={(cat) => setConfirmDelete({ type: "category", id: cat, label: cat })}
            onAddCategory={() => setCategoryModal({ mode: "create" })}
            rooms={roomsInProperty.list}
            hasNoRoom={roomsInProperty.hasNoRoom}
            itemCountForRoom={(room) => itemCountForRoom(selectedPropertyId, room)}
            onOpenRoom={(room) => pushView({ view: "room", selectedPropertyId, selectedRoom: room })}
            onEditRoom={(room) => setRoomModal({ mode: "edit", room })}
            onDeleteRoom={(room) => setConfirmDelete({ type: "room", id: room, label: room })}
            onAddRoom={() => setRoomModal({ mode: "create" })}
          />
        ) : (view === "category" || view === "globalCategory") ? (
          <CategoryView
            property={selectedProperty}
            category={selectedCategory}
            subcategories={(categories.find((c) => c.name === selectedCategory)?.subcategories) || []}
            items={currentItems}
            personName={personName}
            propertyName={propertyName}
            onAddItem={() => setItemModal({ mode: "create" })}
            onOpenItem={(it) => setItemDetail(it.id)}
          />
        ) : view === "room" ? (
          <RoomView
            property={selectedProperty}
            room={selectedRoom}
            items={currentItems}
            onAddItem={() => setItemModal({ mode: "create" })}
            onOpenItem={(it) => setItemDetail(it.id)}
          />
        ) : null}
      </main>

      {propertyModal && (
        <PropertyModal
          initial={propertyModal.property}
          onClose={() => setPropertyModal(null)}
          onSave={(name, type, id) => { saveProperty(name, type, id); setPropertyModal(null); }}
        />
      )}

      {categoryModal && (
        <CategoryModal
          initial={categoryModal.category}
          existing={categories.map((c) => c.name)}
          subcategories={categoryModal.category ? (categories.find((c) => c.name === categoryModal.category)?.subcategories || []) : []}
          onClose={() => setCategoryModal(null)}
          onSave={(name, oldName) => { saveCategory(name, oldName); setCategoryModal(null); }}
          onAddSubcategory={(sub) => saveSubcategory(categoryModal.category, sub)}
          onRenameSubcategory={(oldSub, newSub) => saveSubcategory(categoryModal.category, newSub, oldSub)}
          onDeleteSubcategory={(sub) => deleteSubcategory(categoryModal.category, sub)}
        />
      )}

      {roomModal && (
        <RoomModal
          initial={roomModal.room}
          existing={roomsInProperty.list}
          onClose={() => setRoomModal(null)}
          onSave={(name, oldName) => { saveRoom(selectedPropertyId, name, oldName); setRoomModal(null); }}
        />
      )}

      {peopleModal && (
        <PeopleModal
          people={people}
          tasks={data.tasks || []}
          propertyName={propertyName}
          onClose={() => setPeopleModal(false)}
          onSave={savePerson}
          onDelete={deletePerson}
          onAssignTask={(personId) => { setPeopleModal(false); setTaskModal({ mode: "create", presetPersonId: personId }); }}
          onOpenTask={(taskId) => { setPeopleModal(false); setTaskDetail(taskId); }}
        />
      )}

      {itemModal && (
        <ItemFormModal
          item={itemModal.item}
          properties={properties}
          people={people}
          categories={categories}
          defaultPropertyId={selectedPropertyId}
          defaultCategory={(view === "category" || view === "globalCategory") ? selectedCategory : ""}
          defaultLocation={view === "room" ? selectedRoom : ""}
          onClose={() => setItemModal(null)}
          onSave={(item) => { upsertItem(item); setItemModal(null); }}
        />
      )}

      {itemDetail && (
        <ItemDetailModal
          item={items.find((it) => it.id === itemDetail) || null}
          propertyName={propertyName}
          personName={personName}
          showLocation={view === "globalCategory"}
          onClose={() => setItemDetail(null)}
          onEdit={(it) => { setItemModal({ mode: "edit", item: it }); setItemDetail(null); }}
          onDelete={(it) => { setConfirmDelete({ type: "item", id: it.id, label: it.name }); setItemDetail(null); }}
        />
      )}

      {taskModal && (
        <TaskModal
          task={taskModal.task}
          presetPersonId={taskModal.presetPersonId}
          people={people}
          properties={properties}
          items={items}
          propertyName={propertyName}
          onClose={() => setTaskModal(null)}
          onSave={(task) => { upsertTask(task); setTaskModal(null); }}
        />
      )}

      {taskDetail && (
        <TaskDetailModal
          task={(data.tasks || []).find((t) => t.id === taskDetail) || null}
          items={items}
          personName={personName}
          propertyName={propertyName}
          onClose={() => setTaskDetail(null)}
          onEdit={(t) => { setTaskModal({ mode: "edit", task: t }); setTaskDetail(null); }}
          onDelete={(t) => { setConfirmDelete({ type: "task", id: t.id, label: `${personName(t.personId) || "This"} task` }); setTaskDetail(null); }}
          onComplete={completeTask}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          label={confirmDelete.label}
          type={confirmDelete.type}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            if (confirmDelete.type === "property") deleteProperty(confirmDelete.id);
            if (confirmDelete.type === "category") deleteCategory(confirmDelete.id);
            if (confirmDelete.type === "room") deleteRoom(selectedPropertyId, confirmDelete.id);
            if (confirmDelete.type === "item") deleteItem(confirmDelete.id);
            if (confirmDelete.type === "task") deleteTask(confirmDelete.id);
            setConfirmDelete(null);
          }}
        />
      )}

      {whoAreYouOpen && (
        <WhoAreYouModal
          people={people}
          authEmail={authUser?.email}
          onPick={linkMeToPerson}
          onAddNew={(name) => {
            const newPerson = { id: uid(), name };
            setData((d) => ({ ...d, people: [...d.people, newPerson] }));
            linkMeToPerson(newPerson.id);
          }}
          onSkip={() => setWhoAreYouOpen(false)}
        />
      )}
    </div>
  );
}

/* ---------- Breadcrumb ---------- */
function Breadcrumb({ property, category, room, onHome, onProperty }) {
  return (
    <div style={styles.breadcrumb}>
      <button style={styles.crumbBtn} onClick={onHome}>All properties</button>
      {property && (
        <>
          <span style={styles.crumbSep}>/</span>
          <button style={styles.crumbBtn} onClick={onProperty}>{property.name}</button>
        </>
      )}
      {category !== null && category !== undefined && (
        <>
          <span style={styles.crumbSep}>/</span>
          <span style={styles.crumbCurrent}>{category || "Uncategorized"}</span>
        </>
      )}
      {room !== null && room !== undefined && (
        <>
          <span style={styles.crumbSep}>/</span>
          <span style={styles.crumbCurrent}>{room || "No location set"}</span>
        </>
      )}
    </div>
  );
}

/* ---------- Home: collapsible sections ---------- */
// Long-press detector, independent of the drag library: holding a tile
// still for a moment (without much finger/mouse movement) fires the
// callback. Used to unlock rearrange mode, the same two-step gesture as
// the iPhone home screen — hold to unlock, then a separate drag to move.
function useLongPress(onLongPress, { delay = 500, moveThreshold = 10 } = {}) {
  const timerRef = useRef(null);
  const startPos = useRef({ x: 0, y: 0 });
  const start = (e) => {
    startPos.current = { x: e.clientX, y: e.clientY };
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onLongPress();
    }, delay);
  };
  const clear = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };
  const move = (e) => {
    if (!timerRef.current) return;
    if (Math.abs(e.clientX - startPos.current.x) > moveThreshold || Math.abs(e.clientY - startPos.current.y) > moveThreshold) clear();
  };
  return { onPointerDown: start, onPointerUp: clear, onPointerLeave: clear, onPointerCancel: clear, onPointerMove: move };
}

function HomeView({
  properties, categories,
  itemCountForProperty, itemCountForCategoryGlobal, hasGlobalUncategorized,
  onOpen, onEdit, onDelete, onAdd, onOpenGlobalCategory, onAddCategory,
  onReorderProperties, onReorderCategories,
}) {
  const houses = properties.filter((p) => p.type === "house");
  const storage = properties.filter((p) => p.type === "storage");
  const [openSections, setOpenSections] = useState({ houses: false, storage: false, categories: false });
  const toggle = (key) => setOpenSections((s) => ({ ...s, [key]: !s[key] }));

  // Only one section can be "unlocked" for rearranging at a time — hold a
  // tile to unlock its section (tiles start jiggling), drag to reorder,
  // then tap Done. Outside this mode, dragging is impossible, so an
  // ordinary tap or scroll can never be mistaken for a drag.
  const [rearrangeSection, setRearrangeSection] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 100, tolerance: 8 } })
  );

  if (properties.length === 0) {
    return (
      <EmptyState
        icon={<Home size={30} color="#E8834A" />}
        title="No properties yet"
        body="Add your first house or storage spot to get started."
        actionLabel="Add a property"
        onAction={onAdd}
      />
    );
  }

  return (
    <div>
      {houses.length > 0 && (
        <CollapsibleSection
          icon={<Home size={15} />}
          label="Houses"
          count={houses.length}
          open={openSections.houses}
          onToggle={() => toggle("houses")}
        >
          <RearrangeBar active={rearrangeSection === "houses"} onDone={() => setRearrangeSection(null)} />
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={(e) => {
              const { active, over } = e;
              if (over && active.id !== over.id) onReorderProperties("house", active.id, over.id);
            }}
          >
            <SortableContext items={houses.map((p) => p.id)} strategy={rectSortingStrategy}>
              <TileGrid>
                {houses.map((p) => (
                  <PropertyTile key={p.id} property={p} colorIndex={properties.indexOf(p)}
                    count={itemCountForProperty(p.id)} onOpen={() => onOpen(p.id)}
                    onEdit={() => onEdit(p)} onDelete={() => onDelete(p)}
                    rearranging={rearrangeSection === "houses"}
                    onRequestRearrange={() => setRearrangeSection("houses")} />
                ))}
              </TileGrid>
            </SortableContext>
          </DndContext>
        </CollapsibleSection>
      )}

      {storage.length > 0 && (
        <CollapsibleSection
          icon={<Warehouse size={15} />}
          label="Storage"
          count={storage.length}
          open={openSections.storage}
          onToggle={() => toggle("storage")}
        >
          <RearrangeBar active={rearrangeSection === "storage"} onDone={() => setRearrangeSection(null)} />
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={(e) => {
              const { active, over } = e;
              if (over && active.id !== over.id) onReorderProperties("storage", active.id, over.id);
            }}
          >
            <SortableContext items={storage.map((p) => p.id)} strategy={rectSortingStrategy}>
              <TileGrid>
                {storage.map((p) => (
                  <PropertyTile key={p.id} property={p} colorIndex={properties.indexOf(p)}
                    count={itemCountForProperty(p.id)} onOpen={() => onOpen(p.id)}
                    onEdit={() => onEdit(p)} onDelete={() => onDelete(p)}
                    rearranging={rearrangeSection === "storage"}
                    onRequestRearrange={() => setRearrangeSection("storage")} />
                ))}
              </TileGrid>
            </SortableContext>
          </DndContext>
        </CollapsibleSection>
      )}

      <button style={styles.addTile} onClick={onAdd}>
        <Plus size={16} /> Add a property
      </button>

      {(categories.length > 0 || hasGlobalUncategorized) && (
        <CollapsibleSection
          icon={<Tag size={15} />}
          label="Item categories"
          count={categories.length + (hasGlobalUncategorized ? 1 : 0)}
          open={openSections.categories}
          onToggle={() => toggle("categories")}
        >
          <div style={styles.pageSubtitle}>See everything in a category, across every property. Press and hold a tile to reorder.</div>
          <RearrangeBar active={rearrangeSection === "categories"} onDone={() => setRearrangeSection(null)} />
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={(e) => {
              const { active, over } = e;
              if (over && active.id !== over.id) onReorderCategories(active.id, over.id);
            }}
          >
            <SortableContext items={categories.map((c) => c.name)} strategy={rectSortingStrategy}>
              <TileGrid>
                {categories.map((cat, i) => (
                  <CategoryTile
                    key={cat.name}
                    id={cat.name}
                    name={cat.name}
                    color={TILE_COLORS[i % TILE_COLORS.length]}
                    count={itemCountForCategoryGlobal(cat.name)}
                    onOpen={() => onOpenGlobalCategory(cat.name)}
                    rearranging={rearrangeSection === "categories"}
                    onRequestRearrange={() => setRearrangeSection("categories")}
                  />
                ))}
                {hasGlobalUncategorized && (
                  <div style={styles.tile} onClick={() => onOpenGlobalCategory("")}>
                    <div style={{ ...styles.tileIconWrap, background: "#9C846822", color: "#8A8577" }}><Box size={26} /></div>
                    <div style={styles.tileName}>Uncategorized</div>
                    <div style={styles.tileMeta}>{itemCountForCategoryGlobal("")} item{itemCountForCategoryGlobal("") === 1 ? "" : "s"}</div>
                  </div>
                )}
              </TileGrid>
            </SortableContext>
          </DndContext>
          <button style={styles.addTile} onClick={onAddCategory}>
            <Plus size={16} /> Add a category
          </button>
        </CollapsibleSection>
      )}
      {categories.length === 0 && !hasGlobalUncategorized && (
        <button style={styles.addTile} onClick={onAddCategory}>
          <Tag size={16} /> Add a category
        </button>
      )}
    </div>
  );
}

function RearrangeBar({ active, onDone }) {
  if (!active) return null;
  return (
    <div style={styles.rearrangeBar}>
      <span>Hold and drag a tile to move it.</span>
      <button style={styles.primaryBtn} onClick={onDone}>Done</button>
    </div>
  );
}

function CollapsibleSection({ icon, label, count, open, onToggle, children }) {
  return (
    <div style={styles.collapsibleSection}>
      <button style={styles.collapsibleBar} onClick={onToggle}>
        <span style={styles.collapsibleBarLeft}>
          {icon}
          <span style={styles.collapsibleBarLabel}>{label}</span>
          <span style={styles.collapsibleBarCount}>{count}</span>
        </span>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open && <div style={styles.collapsibleContent}>{children}</div>}
    </div>
  );
}

function TileGrid({ children }) {
  return <div style={styles.tileGrid}>{children}</div>;
}

function PropertyTile({ property, colorIndex, count, rearranging, onOpen, onEdit, onDelete, onRequestRearrange }) {
  const color = TILE_COLORS[colorIndex % TILE_COLORS.length];
  const Icon = property.type === "house" ? Home : Warehouse;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: property.id, disabled: !rearranging });
  const longPress = useLongPress(onRequestRearrange);
  const style = {
    ...styles.tile,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : 1,
    touchAction: rearranging ? "none" : "auto",
    cursor: rearranging ? "grab" : "pointer",
  };
  const dragProps = rearranging ? { ...attributes, ...listeners } : {};
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={rearranging && !isDragging ? "jiggle" : ""}
      {...dragProps}
      {...longPress}
      onClick={rearranging ? undefined : onOpen}
    >
      <div style={{ ...styles.tileIconWrap, background: color + "22", color }}>
        <Icon size={26} />
      </div>
      <div style={styles.tileName}>{property.name}</div>
      <div style={styles.tileMeta}>{count} item{count === 1 ? "" : "s"}</div>
      {!rearranging && (
        <div style={styles.tileActions}>
          <button style={styles.tileIconBtn} onClick={(e) => { e.stopPropagation(); onEdit(); }}><Edit3 size={13} /></button>
          <button style={styles.tileIconBtn} onClick={(e) => { e.stopPropagation(); onDelete(); }}><Trash2 size={13} /></button>
        </div>
      )}
    </div>
  );
}

function CategoryTile({ id, name, color, count, rearranging, onOpen, onRequestRearrange }) {
  const Icon = categoryIcon(name);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !rearranging });
  const longPress = useLongPress(onRequestRearrange);
  const style = {
    ...styles.tile,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : 1,
    touchAction: rearranging ? "none" : "auto",
    cursor: rearranging ? "grab" : "pointer",
  };
  const dragProps = rearranging ? { ...attributes, ...listeners } : {};
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={rearranging && !isDragging ? "jiggle" : ""}
      {...dragProps}
      {...longPress}
      onClick={rearranging ? undefined : onOpen}
    >
      <div style={{ ...styles.tileIconWrap, background: color + "22", color }}><Icon size={26} /></div>
      <div style={styles.tileName}>{name}</div>
      <div style={styles.tileMeta}>{count} item{count === 1 ? "" : "s"}</div>
    </div>
  );
}

/* ---------- Property view: category grid ---------- */
function PropertyView({
  property, categories, hasUncategorized, itemCountForCategory, onOpenCategory, onEditCategory, onDeleteCategory, onAddCategory,
  rooms, hasNoRoom, itemCountForRoom, onOpenRoom, onEditRoom, onDeleteRoom, onAddRoom,
}) {
  return (
    <div>
      <h1 style={styles.pageTitle}>{property.name}</h1>

      <div style={styles.propertySectionLabel}>Categories</div>
      <div style={styles.pageSubtitle}>Choose a category to see what's logged there</div>
      <TileGrid>
        {categories.map((cat, i) => {
          const Icon = categoryIcon(cat.name);
          const color = TILE_COLORS[i % TILE_COLORS.length];
          return (
            <div key={cat.name} style={styles.tile} onClick={() => onOpenCategory(cat.name)}>
              <div style={{ ...styles.tileIconWrap, background: color + "22", color }}><Icon size={26} /></div>
              <div style={styles.tileName}>{cat.name}</div>
              <div style={styles.tileMeta}>{itemCountForCategory(cat.name)} item{itemCountForCategory(cat.name) === 1 ? "" : "s"}</div>
              <div style={styles.tileActions}>
                <button style={styles.tileIconBtn} onClick={(e) => { e.stopPropagation(); onEditCategory(cat.name); }}><Edit3 size={13} /></button>
                <button style={styles.tileIconBtn} onClick={(e) => { e.stopPropagation(); onDeleteCategory(cat.name); }}><Trash2 size={13} /></button>
              </div>
            </div>
          );
        })}
        {hasUncategorized && (
          <div style={styles.tile} onClick={() => onOpenCategory("")}>
            <div style={{ ...styles.tileIconWrap, background: "#9C846822", color: "#8A8577" }}><Box size={26} /></div>
            <div style={styles.tileName}>Uncategorized</div>
            <div style={styles.tileMeta}>{itemCountForCategory("")} item{itemCountForCategory("") === 1 ? "" : "s"}</div>
          </div>
        )}
      </TileGrid>
      <button style={styles.addTile} onClick={onAddCategory}>
        <Plus size={16} /> Add a category
      </button>

      <div style={{ ...styles.propertySectionLabel, marginTop: 26 }}>Rooms</div>
      <div style={styles.pageSubtitle}>Browse this property by where things actually are.</div>
      <TileGrid>
        {rooms.map((room, i) => {
          const color = TILE_COLORS[(i + 3) % TILE_COLORS.length];
          const count = itemCountForRoom(room);
          return (
            <div key={room} style={styles.tile} onClick={() => onOpenRoom(room)}>
              <div style={{ ...styles.tileIconWrap, background: color + "22", color }}><MapPin size={24} /></div>
              <div style={styles.tileName}>{room}</div>
              <div style={styles.tileMeta}>{count} item{count === 1 ? "" : "s"}</div>
              <div style={styles.tileActions}>
                <button style={styles.tileIconBtn} onClick={(e) => { e.stopPropagation(); onEditRoom(room); }}><Edit3 size={13} /></button>
                <button style={styles.tileIconBtn} onClick={(e) => { e.stopPropagation(); onDeleteRoom(room); }}><Trash2 size={13} /></button>
              </div>
            </div>
          );
        })}
        {hasNoRoom && (
          <div style={styles.tile} onClick={() => onOpenRoom("")}>
            <div style={{ ...styles.tileIconWrap, background: "#9C846822", color: "#8A8577" }}><Box size={24} /></div>
            <div style={styles.tileName}>No location set</div>
            <div style={styles.tileMeta}>{itemCountForRoom("")} item{itemCountForRoom("") === 1 ? "" : "s"}</div>
          </div>
        )}
      </TileGrid>
      <button style={styles.addTile} onClick={onAddRoom}>
        <Plus size={16} /> Add a room
      </button>
    </div>
  );
}

/* ---------- Category view: item list ---------- */
function CategoryView({ property, category, subcategories, items, personName, propertyName, onAddItem, onOpenItem }) {
  const hasPhotos = items.some((it) => it.photo);
  const [showPhotos, setShowPhotos] = useState(true);
  const [subFilter, setSubFilter] = useState("");

  const visibleItems = subFilter ? items.filter((it) => (it.subcategory || "") === subFilter) : items;

  return (
    <div>
      <div style={styles.itemListHeader}>
        <div>
          <h1 style={styles.pageTitle}>{category || "Uncategorized"}</h1>
          <div style={styles.pageSubtitle}>
            {property ? property.name : "All properties"} · {visibleItems.length} item{visibleItems.length === 1 ? "" : "s"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {hasPhotos && (
            <button style={styles.secondaryBtn} onClick={() => setShowPhotos((s) => !s)}>
              {showPhotos ? <ImageOff size={14} /> : <ImageIcon size={14} />}
              {showPhotos ? "Hide photos" : "Show photos"}
            </button>
          )}
          <button style={styles.primaryBtn} onClick={onAddItem}><Plus size={16} /> Log item</button>
        </div>
      </div>

      {subcategories && subcategories.length > 0 && (
        <div style={styles.subFilterRow}>
          <button
            style={{ ...styles.subFilterChip, ...(subFilter === "" ? styles.subFilterChipActive : {}) }}
            onClick={() => setSubFilter("")}
          >
            All
          </button>
          {subcategories.map((s) => (
            <button
              key={s}
              style={{ ...styles.subFilterChip, ...(subFilter === s ? styles.subFilterChipActive : {}) }}
              onClick={() => setSubFilter(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {visibleItems.length === 0 ? (
        <EmptyState
          icon={<Package size={30} color="#E8834A" />}
          title="Nothing logged here yet"
          body="Add the first item to this category."
          actionLabel="Log an item"
          onAction={onAddItem}
        />
      ) : (
        <div style={styles.itemTileGrid}>
          {visibleItems.map((it) => (
            <ItemCompactTile
              key={it.id}
              item={it}
              showPhoto={showPhotos}
              locationLabel={property ? null : propertyName(it.propertyId)}
              onClick={() => onOpenItem(it)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Room view: item list ---------- */
function RoomView({ property, room, items, onAddItem, onOpenItem }) {
  const hasPhotos = items.some((it) => it.photo);
  const [showPhotos, setShowPhotos] = useState(true);

  return (
    <div>
      <div style={styles.itemListHeader}>
        <div>
          <h1 style={styles.pageTitle}>{room || "No location set"}</h1>
          <div style={styles.pageSubtitle}>{property.name} · {items.length} item{items.length === 1 ? "" : "s"}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {hasPhotos && (
            <button style={styles.secondaryBtn} onClick={() => setShowPhotos((s) => !s)}>
              {showPhotos ? <ImageOff size={14} /> : <ImageIcon size={14} />}
              {showPhotos ? "Hide photos" : "Show photos"}
            </button>
          )}
          <button style={styles.primaryBtn} onClick={onAddItem}><Plus size={16} /> Log item</button>
        </div>
      </div>
      {items.length === 0 ? (
        <EmptyState
          icon={<MapPin size={30} color="#E8834A" />}
          title="Nothing logged here yet"
          body="Add the first item at this location."
          actionLabel="Log an item"
          onAction={onAddItem}
        />
      ) : (
        <div style={styles.itemTileGrid}>
          {items.map((it) => (
            <ItemCompactTile key={it.id} item={it} showPhoto={showPhotos} onClick={() => onOpenItem(it)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ItemCompactTile({ item, showPhoto, locationLabel, onClick }) {
  const displayPhoto = showPhoto && !!item.photo;
  return (
    <div style={styles.itemCompactTile} onClick={onClick}>
      {displayPhoto && <img src={item.photo} alt={item.name} style={styles.itemCompactPhoto} />}
      <div style={styles.itemCompactName}>{item.name}</div>
      {locationLabel && <div style={styles.itemCompactLocation}>{locationLabel}</div>}
    </div>
  );
}

/* ---------- Search results (home) ---------- */
function SearchResultsView({ results, propertyName, onOpenItem }) {
  return (
    <div>
      <div style={styles.pageSubtitle}>{results.length} result{results.length === 1 ? "" : "s"}</div>
      {results.length === 0 ? (
        <EmptyState icon={<Search size={26} color="#E8834A" />} title="No matches" body="Try a different search term or clear the filter." />
      ) : (
        <div style={{ ...styles.itemTileGrid, marginTop: 14 }}>
          {results.map((it) => (
            <ItemCompactTile
              key={it.id}
              item={it}
              showPhoto
              locationLabel={propertyName(it.propertyId)}
              onClick={() => onOpenItem(it)}
            />
          ))}
        </div>
      )}
    </div>
  );
}


/* ---------- Item detail popup ---------- */
function ItemDetailModal({ item, propertyName, personName, showLocation, onClose, onEdit, onDelete }) {
  if (!item) return null;
  const statusLabel = item.status === "in_use" ? "In use"
    : item.status === "loan" ? `On loan to ${personName(item.loanedTo) || "someone"}`
    : "In storage";
  return (
    <ModalShell onClose={onClose} title={item.name} width={460}>
      <div style={styles.formGrid}>
        {item.photo && <img src={item.photo} alt={item.name} style={styles.detailPhoto} />}

        <div style={styles.detailRow}>
          <span style={styles.detailLabel}>Quantity</span>
          <span style={styles.detailValue}>{item.quantity || 1}</span>
        </div>
        <div style={styles.detailRow}>
          <span style={styles.detailLabel}>Status</span>
          <span style={styles.detailValue}>{statusLabel}</span>
        </div>
        {showLocation && (
          <div style={styles.detailRow}>
            <span style={styles.detailLabel}>Property</span>
            <span style={styles.detailValue}>{propertyName(item.propertyId)}</span>
          </div>
        )}
        <div style={styles.detailRow}>
          <span style={styles.detailLabel}>Category</span>
          <span style={styles.detailValue}>
            {item.category || "Uncategorized"}{item.subcategory ? ` › ${item.subcategory}` : ""}
          </span>
        </div>

        {item.customFields?.length > 0 && (
          <div>
            <div style={styles.fieldLabel}>Custom fields</div>
            <div style={styles.customFieldList}>
              {item.customFields.map((f, i) => f.key ? (
                <div key={i} style={styles.customField}>
                  <span style={styles.customFieldKey}>{f.key}</span>
                  <span style={styles.customFieldVal}>{f.value}</span>
                </div>
              ) : null)}
            </div>
          </div>
        )}

        {item.notes && (
          <div>
            <div style={styles.fieldLabel}>Notes</div>
            <div style={styles.tagNotes}>{item.notes}</div>
          </div>
        )}

        <div style={styles.formActions}>
          <button style={styles.secondaryBtn} onClick={() => onDelete(item)}><Trash2 size={14} /> Delete</button>
          <button style={styles.primaryBtn} onClick={() => onEdit(item)}><Edit3 size={14} /> Edit</button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ---------- Task (move list) modal ---------- */
function TaskModal({ task, presetPersonId, people, properties, items, propertyName, onClose, onSave }) {
  const [personId, setPersonId] = useState(task?.personId || presetPersonId || people[0]?.id || "");
  const [destinationPropertyId, setDestinationPropertyId] = useState(task?.destinationPropertyId || properties[0]?.id || "");
  const [sourcePropertyId, setSourcePropertyId] = useState("");
  const [itemIds, setItemIds] = useState(task?.itemIds || []);
  const [notes, setNotes] = useState(task?.notes || "");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [expandedGroups, setExpandedGroups] = useState({});

  const candidateItems = useMemo(() => {
    return items
      .filter((it) => it.propertyId !== destinationPropertyId || itemIds.includes(it.id))
      .filter((it) => !sourcePropertyId || it.propertyId === sourcePropertyId || itemIds.includes(it.id))
      .filter((it) => !search.trim() || it.name.toLowerCase().includes(search.trim().toLowerCase()));
  }, [items, destinationPropertyId, sourcePropertyId, itemIds, search]);

  // Group candidate items as property -> category -> items, so the picker
  // matches the same drill-down shape as the rest of the app.
  const grouped = useMemo(() => {
    const byProperty = {};
    for (const it of candidateItems) {
      const propId = it.propertyId;
      if (!byProperty[propId]) byProperty[propId] = { propertyId: propId, categories: {} };
      const catName = it.category || "Uncategorized";
      if (!byProperty[propId].categories[catName]) byProperty[propId].categories[catName] = [];
      byProperty[propId].categories[catName].push(it);
    }
    return Object.values(byProperty).sort((a, b) => propertyName(a.propertyId).localeCompare(propertyName(b.propertyId)));
  }, [candidateItems, propertyName]);

  const toggleItem = (id) => {
    setItemIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };
  const toggleGroup = (key) => setExpandedGroups((g) => ({ ...g, [key]: !g[key] }));
  const isExpanded = (key) => (search.trim() ? true : !!expandedGroups[key]);

  const handleSave = () => {
    if (!personId) return setError("Choose who this is assigned to.");
    if (!destinationPropertyId) return setError("Choose where these items are headed.");
    if (itemIds.length === 0) return setError("Pick at least one item to move.");
    onSave({
      id: task?.id || uid(),
      personId,
      destinationPropertyId,
      itemIds,
      notes: notes.trim(),
      dateCreated: task?.dateCreated || new Date().toISOString(),
    });
  };

  return (
    <ModalShell onClose={onClose} title={task ? "Edit move task" : "Assign a move task"} width={540}>
      <div style={styles.formGrid}>
        <div style={styles.formRow2}>
          <Field label="Move from">
            <select style={styles.input} value={sourcePropertyId} onChange={(e) => setSourcePropertyId(e.target.value)}>
              <option value="">Any property</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Move to">
            <select style={styles.input} value={destinationPropertyId} onChange={(e) => setDestinationPropertyId(e.target.value)}>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Assign to">
          <select style={styles.input} value={personId} onChange={(e) => setPersonId(e.target.value)}>
            {people.length === 0 && <option value="">Add a person first</option>}
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>

        <Field label={`Items to move (${itemIds.length} selected)`}>
          <input
            style={{ ...styles.input, marginBottom: 6 }}
            placeholder="Search items…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div style={styles.taskItemPicker}>
            {grouped.length === 0 && (
              <div style={{ fontSize: 12.5, color: MUTED, padding: "8px 4px" }}>No matching items.</div>
            )}
            {grouped.map((propGroup) => {
              const propKey = propGroup.propertyId;
              const propItemCount = Object.values(propGroup.categories).flat().length;
              return (
                <div key={propKey} style={styles.taskGroupProperty}>
                  <button type="button" style={styles.taskGroupBar} onClick={() => toggleGroup(propKey)}>
                    {isExpanded(propKey) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span style={{ fontWeight: 600, flex: 1, textAlign: "left" }}>{propertyName(propKey)}</span>
                    <span style={styles.taskItemPickerLocation}>{propItemCount}</span>
                  </button>
                  {isExpanded(propKey) && Object.entries(propGroup.categories).map(([catName, catItems]) => {
                    const catKey = `${propKey}::${catName}`;
                    return (
                      <div key={catKey} style={styles.taskGroupCategory}>
                        <button type="button" style={styles.taskGroupBarSmall} onClick={() => toggleGroup(catKey)}>
                          {isExpanded(catKey) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          <span style={{ flex: 1, textAlign: "left" }}>{catName}</span>
                          <span style={styles.taskItemPickerLocation}>{catItems.length}</span>
                        </button>
                        {isExpanded(catKey) && catItems.map((it) => (
                          <label key={it.id} style={{ ...styles.taskItemPickerRow, paddingLeft: 30 }}>
                            <input type="checkbox" checked={itemIds.includes(it.id)} onChange={() => toggleItem(it.id)} />
                            <span style={{ flex: 1 }}>{it.name}</span>
                          </label>
                        ))}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </Field>

        <Field label="Notes">
          <textarea style={{ ...styles.input, minHeight: 50, resize: "vertical" }} value={notes}
            onChange={(e) => setNotes(e.target.value)} placeholder="Anything worth mentioning" />
        </Field>

        {error && <div style={styles.formError}><AlertCircle size={14} /> {error}</div>}

        <div style={styles.formActions}>
          <button style={styles.secondaryBtn} onClick={onClose}>Cancel</button>
          <button style={styles.primaryBtn} onClick={handleSave}><Check size={15} /> {task ? "Save changes" : "Assign task"}</button>
        </div>
      </div>
    </ModalShell>
  );
}

function TaskDetailModal({ task, items, personName, propertyName, onClose, onEdit, onDelete, onComplete }) {
  if (!task) return null;
  const taskItems = task.itemIds.map((id) => items.find((it) => it.id === id)).filter(Boolean);
  return (
    <ModalShell onClose={onClose} title={`Move task: ${personName(task.personId)}`} width={480}>
      <div style={styles.formGrid}>
        <div style={styles.detailRow}>
          <span style={styles.detailLabel}>Assigned to</span>
          <span style={styles.detailValue}>{personName(task.personId)}</span>
        </div>
        <div style={styles.detailRow}>
          <span style={styles.detailLabel}>Destination</span>
          <span style={styles.detailValue}>{propertyName(task.destinationPropertyId)}</span>
        </div>
        {task.notes && (
          <div>
            <div style={styles.fieldLabel}>Notes</div>
            <div style={styles.tagNotes}>{task.notes}</div>
          </div>
        )}
        <div>
          <div style={styles.fieldLabel}>Items ({taskItems.length})</div>
          <div style={styles.taskItemPicker}>
            {taskItems.map((it) => (
              <div key={it.id} style={styles.taskItemPickerRow}>
                <span style={{ flex: 1 }}>{it.name}</span>
                <span style={styles.taskItemPickerLocation}>currently: {propertyName(it.propertyId)}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={styles.formActions}>
          <button style={styles.secondaryBtn} onClick={() => onDelete(task)}><Trash2 size={14} /> Delete</button>
          <button style={styles.secondaryBtn} onClick={() => onEdit(task)}><Edit3 size={14} /> Edit</button>
          <button style={styles.primaryBtn} onClick={() => onComplete(task)}><CheckCircle2 size={15} /> Mark moved</button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ---------- Empty state ---------- */
function EmptyState({ icon, title, body, actionLabel, onAction }) {
  return (
    <div style={styles.emptyState}>
      <div style={styles.emptyIcon}>{icon}</div>
      <div style={styles.emptyTitle}>{title}</div>
      <div style={styles.emptyBody}>{body}</div>
      {actionLabel && <button style={styles.primaryBtn} onClick={onAction}><Plus size={15} /> {actionLabel}</button>}
    </div>
  );
}

/* ---------- Item form modal ---------- */
function ItemFormModal({ item, properties, people, categories, defaultPropertyId, defaultCategory, defaultLocation, onClose, onSave }) {
  const [name, setName] = useState(item?.name || "");
  const [propertyId, setPropertyId] = useState(item?.propertyId || defaultPropertyId || properties[0]?.id || "");
  const [location, setLocation] = useState(item?.location ?? defaultLocation ?? "");
  const [newLocation, setNewLocation] = useState("");
  const [addingLocation, setAddingLocation] = useState(false);
  const [category, setCategory] = useState(item?.category ?? defaultCategory ?? "");
  const [newCategory, setNewCategory] = useState("");
  const [addingCategory, setAddingCategory] = useState(false);
  const [subcategory, setSubcategory] = useState(item?.subcategory || "");
  const [newSubcategory, setNewSubcategory] = useState("");
  const [addingSubcategory, setAddingSubcategory] = useState(false);
  const [status, setStatus] = useState(item?.status || "storage"); // 'in_use' | 'storage' | 'loan'
  const [loanedTo, setLoanedTo] = useState(item?.loanedTo || "");
  const [quantity, setQuantity] = useState(item?.quantity ?? 1);
  const [notes, setNotes] = useState(item?.notes || "");
  const [customFields, setCustomFields] = useState(item?.customFields?.length ? item.customFields : [{ key: "", value: "" }]);
  const [photo, setPhoto] = useState(item?.photo || null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);

  const currentProperty = properties.find((p) => p.id === propertyId);
  const availableRooms = currentProperty?.rooms || [];
  const currentCategoryObj = categories.find((c) => c.name === category);
  const availableSubcategories = currentCategoryObj?.subcategories || [];

  const updateField = (i, key, value) => setCustomFields((f) => f.map((row, idx) => (idx === i ? { ...row, [key]: value } : row)));
  const addFieldRow = () => setCustomFields((f) => [...f, { key: "", value: "" }]);
  const removeFieldRow = (i) => setCustomFields((f) => f.filter((_, idx) => idx !== i));

  const handlePhotoChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoBusy(true);
    setError("");
    try {
      const dataUrl = await Promise.race([
        compressImageFile(file),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out")), 15000)),
      ]);
      setPhoto(dataUrl);
    } catch (err) {
      console.error("photo processing failed:", err);
      setError(err?.message && err.message !== "Timed out" ? err.message : "Couldn't process that photo — try a different one.");
    } finally {
      setPhotoBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (cameraInputRef.current) cameraInputRef.current.value = "";
    }
  };

  const handleSave = () => {
    if (!name.trim()) return setError("Give the item a name.");
    if (!propertyId) return setError("Choose a property.");
    if (addingLocation && !newLocation.trim()) return setError("Type a name for the new location, or cancel it.");
    if (addingCategory && !newCategory.trim()) return setError("Type a name for the new category, or cancel it.");
    if (addingSubcategory && !newSubcategory.trim()) return setError("Type a name for the new subcategory, or cancel it.");
    if (status === "loan" && !loanedTo) return setError("Choose who it's on loan to.");
    const finalLocation = addingLocation ? newLocation.trim() : location;
    const finalCategory = addingCategory ? newCategory.trim() : category;
    const finalSubcategory = addingCategory ? "" : (addingSubcategory ? newSubcategory.trim() : subcategory);
    onSave({
      id: item?.id || uid(),
      name: name.trim(),
      propertyId,
      location: finalLocation,
      category: finalCategory,
      subcategory: finalSubcategory,
      status,
      loanedTo: status === "loan" ? loanedTo : null,
      quantity: Math.max(1, Number(quantity) || 1),
      notes: notes.trim(),
      photo: photo || null,
      customFields: customFields.filter((f) => f.key.trim()),
      dateAdded: item?.dateAdded || new Date().toISOString(),
    });
  };

  return (
    <ModalShell onClose={onClose} title={item ? "Edit item" : "Log a new item"} width={520}>
      <div style={styles.formGrid}>
        <Field label="Item name">
          <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Silver plate" />
        </Field>

        <Field label="Photo">
          {photo ? (
            <div style={styles.photoPreviewWrap}>
              <img src={photo} alt="Item preview" style={styles.photoPreview} />
              <button style={styles.secondaryBtn} onClick={() => setPhoto(null)} type="button">
                <X size={14} /> Remove photo
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                style={styles.secondaryBtn}
                type="button"
                disabled={photoBusy}
                onClick={() => cameraInputRef.current?.click()}
              >
                {photoBusy ? <Loader2 size={14} className="spin" /> : <Camera size={14} />}
                {photoBusy ? "Processing…" : "Take photo"}
              </button>
              <button
                style={styles.secondaryBtn}
                type="button"
                disabled={photoBusy}
                onClick={() => fileInputRef.current?.click()}
              >
                <ImageIcon size={14} /> Choose photo
              </button>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handlePhotoChange}
            style={{ display: "none" }}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handlePhotoChange}
            style={{ display: "none" }}
          />
        </Field>

        <Field label="Quantity">
          <input type="number" min="1" style={{ ...styles.input, maxWidth: 120 }} value={quantity}
            onChange={(e) => setQuantity(e.target.value)} placeholder="1" />
        </Field>

        <div style={styles.formRow2}>
          <Field label="Property">
            <select style={styles.input} value={propertyId} onChange={(e) => {
              setPropertyId(e.target.value);
              setLocation("");
              setAddingLocation(false);
            }}>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Location in property">
            {!addingLocation ? (
              <select style={styles.input} value={location} onChange={(e) => {
                if (e.target.value === "__new__") { setAddingLocation(true); }
                else setLocation(e.target.value);
              }}>
                <option value="">Not set</option>
                {availableRooms.map((r) => <option key={r} value={r}>{r}</option>)}
                <option value="__new__">+ New location…</option>
              </select>
            ) : (
              <div style={{ display: "flex", gap: 6 }}>
                <input style={styles.input} value={newLocation} onChange={(e) => setNewLocation(e.target.value)}
                  placeholder="e.g. Garage" autoFocus />
                <button style={styles.iconBtn} onClick={() => { setAddingLocation(false); setNewLocation(""); }}><X size={14} /></button>
              </div>
            )}
          </Field>
        </div>

        <div style={styles.formRow2}>
          <Field label="Category">
            {!addingCategory ? (
              <select style={styles.input} value={category} onChange={(e) => {
                if (e.target.value === "__new__") { setAddingCategory(true); }
                else { setCategory(e.target.value); setSubcategory(""); }
              }}>
                <option value="">Uncategorized</option>
                {categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                <option value="__new__">+ New category…</option>
              </select>
            ) : (
              <div style={{ display: "flex", gap: 6 }}>
                <input style={styles.input} value={newCategory} onChange={(e) => setNewCategory(e.target.value)}
                  placeholder="New category name" autoFocus />
                <button style={styles.iconBtn} onClick={() => { setAddingCategory(false); setNewCategory(""); }}><X size={14} /></button>
              </div>
            )}
          </Field>
        </div>

        {category && !addingCategory && (
          <Field label="Subcategory (optional)">
            {!addingSubcategory ? (
              <select style={styles.input} value={subcategory} onChange={(e) => {
                if (e.target.value === "__new__") { setAddingSubcategory(true); }
                else setSubcategory(e.target.value);
              }}>
                <option value="">None</option>
                {availableSubcategories.map((s) => <option key={s} value={s}>{s}</option>)}
                <option value="__new__">+ New subcategory…</option>
              </select>
            ) : (
              <div style={{ display: "flex", gap: 6 }}>
                <input style={styles.input} value={newSubcategory} onChange={(e) => setNewSubcategory(e.target.value)}
                  placeholder="New subcategory name" autoFocus />
                <button style={styles.iconBtn} onClick={() => { setAddingSubcategory(false); setNewSubcategory(""); }}><X size={14} /></button>
              </div>
            )}
          </Field>
        )}

        <Field label="Status">
          <div style={{ display: "flex", gap: 8 }}>
            <StatusToggle active={status === "storage"} label="In storage" onClick={() => setStatus("storage")} />
            <StatusToggle active={status === "in_use"} label="In use" onClick={() => setStatus("in_use")} />
            <StatusToggle active={status === "loan"} label="On loan" onClick={() => setStatus("loan")} />
          </div>
        </Field>

        {status === "loan" && (
          <Field label="Loaned to">
            <select style={styles.input} value={loanedTo} onChange={(e) => setLoanedTo(e.target.value)}>
              <option value="">— Choose a person —</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}

        <Field label="Notes">
          <textarea style={{ ...styles.input, minHeight: 56, resize: "vertical" }} value={notes}
            onChange={(e) => setNotes(e.target.value)} placeholder="Condition, value, anything worth remembering" />
        </Field>

        <div>
          <div style={styles.fieldLabel}>Custom fields</div>
          {customFields.map((f, i) => (
            <div key={i} style={styles.customFieldRow}>
              <input style={{ ...styles.input, flex: 1 }} placeholder="Field (e.g. Serial #)" value={f.key}
                onChange={(e) => updateField(i, "key", e.target.value)} />
              <input style={{ ...styles.input, flex: 1 }} placeholder="Value" value={f.value}
                onChange={(e) => updateField(i, "value", e.target.value)} />
              <button style={styles.iconBtn} onClick={() => removeFieldRow(i)}><X size={14} /></button>
            </div>
          ))}
          <button style={styles.addFieldBtn} onClick={addFieldRow}><Plus size={13} /> Add custom field</button>
        </div>

        {error && <div style={styles.formError}><AlertCircle size={14} /> {error}</div>}

        <div style={styles.formActions}>
          <button style={styles.secondaryBtn} onClick={onClose}>Cancel</button>
          <button style={styles.primaryBtn} onClick={handleSave}><Check size={15} /> {item ? "Save changes" : "Add item"}</button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ---------- Property modal ---------- */
function PropertyModal({ initial, onClose, onSave }) {
  const [name, setName] = useState(initial?.name || "");
  const [type, setType] = useState(initial?.type || "house");
  const [error, setError] = useState("");
  return (
    <ModalShell onClose={onClose} title={initial ? "Edit property" : "Add a property"} width={420}>
      <div style={styles.formGrid}>
        <Field label="Name">
          <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Lake house" />
        </Field>
        <Field label="Type">
          <div style={{ display: "flex", gap: 8 }}>
            <TypeToggle active={type === "house"} icon={<Home size={14} />} label="House" onClick={() => setType("house")} />
            <TypeToggle active={type === "storage"} icon={<Warehouse size={14} />} label="Storage spot" onClick={() => setType("storage")} />
          </div>
        </Field>
        {error && <div style={styles.formError}><AlertCircle size={14} /> {error}</div>}
        <div style={styles.formActions}>
          <button style={styles.secondaryBtn} onClick={onClose}>Cancel</button>
          <button style={styles.primaryBtn} onClick={() => {
            if (!name.trim()) return setError("Give it a name.");
            onSave(name.trim(), type, initial?.id);
          }}><Check size={15} /> Save</button>
        </div>
      </div>
    </ModalShell>
  );
}

function TypeToggle({ active, icon, label, onClick }) {
  return (
    <button onClick={onClick} style={{ ...styles.typeToggle, ...(active ? styles.typeToggleActive : {}) }}>
      {icon} {label}
    </button>
  );
}

function StatusToggle({ active, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ ...styles.typeToggle, flex: 1, justifyContent: "center", ...(active ? styles.typeToggleActive : {}) }}
    >
      {label}
    </button>
  );
}

/* ---------- Category modal ---------- */
function CategoryModal({ initial, existing, subcategories, onClose, onSave, onAddSubcategory, onRenameSubcategory, onDeleteSubcategory }) {
  const [name, setName] = useState(initial || "");
  const [error, setError] = useState("");
  const [newSub, setNewSub] = useState("");
  const [editingSub, setEditingSub] = useState(null);
  const [editingSubName, setEditingSubName] = useState("");

  return (
    <ModalShell onClose={onClose} title={initial !== undefined ? "Edit category" : "Add a category"} width={420}>
      <div style={styles.formGrid}>
        <Field label="Category name">
          <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Furniture" />
        </Field>
        {error && <div style={styles.formError}><AlertCircle size={14} /> {error}</div>}
        <div style={styles.formActions}>
          <button style={styles.secondaryBtn} onClick={onClose}>Cancel</button>
          <button style={styles.primaryBtn} onClick={() => {
            const trimmed = name.trim();
            if (!trimmed) return setError("Give it a name.");
            if (trimmed !== initial && existing.includes(trimmed)) return setError("That category already exists.");
            onSave(trimmed, initial);
          }}><Check size={15} /> Save</button>
        </div>

        {initial !== undefined && (
          <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 14, marginTop: 4 }}>
            <div style={styles.fieldLabel}>Subcategories</div>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
              e.g. Kitchen could break down into Dishes, Flatware, Glasses.
            </div>
            <div style={styles.manageList}>
              {(subcategories || []).map((sub) => (
                <div key={sub} style={styles.manageItemRow}>
                  {editingSub === sub ? (
                    <>
                      <input style={{ ...styles.input, flex: 1 }} value={editingSubName} onChange={(e) => setEditingSubName(e.target.value)} autoFocus />
                      <button style={styles.iconBtn} onClick={() => {
                        const trimmed = editingSubName.trim();
                        if (trimmed) onRenameSubcategory(sub, trimmed);
                        setEditingSub(null);
                      }}><Check size={14} /></button>
                      <button style={styles.iconBtn} onClick={() => setEditingSub(null)}><X size={14} /></button>
                    </>
                  ) : (
                    <>
                      <span>{sub}</span>
                      <div style={{ display: "flex", gap: 2 }}>
                        <button style={styles.iconBtn} onClick={() => { setEditingSub(sub); setEditingSubName(sub); }}><Edit3 size={13} /></button>
                        <button style={styles.iconBtn} onClick={() => onDeleteSubcategory(sub)}><Trash2 size={13} /></button>
                      </div>
                    </>
                  )}
                </div>
              ))}
              {(subcategories || []).length === 0 && <div style={styles.sidebarEmpty}>None yet.</div>}
            </div>
            <div style={styles.addRow}>
              <input
                style={{ ...styles.input, flex: 1 }}
                placeholder="New subcategory"
                value={newSub}
                onChange={(e) => setNewSub(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && newSub.trim()) { onAddSubcategory(newSub.trim()); setNewSub(""); } }}
              />
              <button style={styles.secondaryBtn} onClick={() => { if (newSub.trim()) { onAddSubcategory(newSub.trim()); setNewSub(""); } }}>
                <Plus size={14} /> Add
              </button>
            </div>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

/* ---------- Room modal ---------- */
function RoomModal({ initial, existing, onClose, onSave }) {
  const [name, setName] = useState(initial || "");
  const [error, setError] = useState("");
  return (
    <ModalShell onClose={onClose} title={initial !== undefined ? "Rename room" : "Add a room"} width={400}>
      <div style={styles.formGrid}>
        <Field label="Room name">
          <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Garage" />
        </Field>
        {error && <div style={styles.formError}><AlertCircle size={14} /> {error}</div>}
        <div style={styles.formActions}>
          <button style={styles.secondaryBtn} onClick={onClose}>Cancel</button>
          <button style={styles.primaryBtn} onClick={() => {
            const trimmed = name.trim();
            if (!trimmed) return setError("Give it a name.");
            if (trimmed !== initial && existing.includes(trimmed)) return setError("That room already exists.");
            onSave(trimmed, initial);
          }}><Check size={15} /> Save</button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ---------- People modal ---------- */
function PeopleModal({ people, tasks, propertyName, onClose, onSave, onDelete, onAssignTask, onOpenTask }) {
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState("");
  const [selectedId, setSelectedId] = useState(null);

  return (
    <ModalShell onClose={onClose} title="Family members" width={440}>
      <div style={styles.addRow}>
        <input style={{ ...styles.input, flex: 1 }} placeholder="Name" value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) { onSave(newName.trim()); setNewName(""); } }} />
        <button style={styles.secondaryBtn} onClick={() => { if (newName.trim()) { onSave(newName.trim()); setNewName(""); } }}>
          <Plus size={14} /> Add
        </button>
      </div>
      <div style={styles.manageList}>
        {people.map((p) => {
          const isSelected = selectedId === p.id;
          const personTasks = tasks.filter((t) => t.personId === p.id);
          return (
            <div key={p.id} style={styles.personBlock}>
              <div style={styles.manageItemRow}>
                {editingId === p.id ? (
                  <>
                    <input style={{ ...styles.input, flex: 1 }} value={editingName} onChange={(e) => setEditingName(e.target.value)} autoFocus />
                    <button style={styles.iconBtn} onClick={() => { onSave(editingName.trim() || p.name, p.id); setEditingId(null); }}><Check size={14} /></button>
                    <button style={styles.iconBtn} onClick={() => setEditingId(null)}><X size={14} /></button>
                  </>
                ) : (
                  <>
                    <button
                      style={styles.personNameBtn}
                      onClick={() => setSelectedId(isSelected ? null : p.id)}
                    >
                      <User size={14} /> {p.name}
                      {isSelected ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <div style={{ display: "flex", gap: 2 }}>
                      <button style={styles.iconBtn} onClick={() => { setEditingId(p.id); setEditingName(p.name); }}><Edit3 size={13} /></button>
                      <button style={styles.iconBtn} onClick={() => onDelete(p.id)}><Trash2 size={13} /></button>
                    </div>
                  </>
                )}
              </div>
              {isSelected && editingId !== p.id && (
                <div style={styles.personExpanded}>
                  {personTasks.length > 0 && (
                    <div style={styles.taskList}>
                      {personTasks.map((t) => (
                        <div key={t.id} style={styles.taskRow} onClick={() => onOpenTask(t.id)}>
                          <div style={styles.taskRowLeft}>
                            <ArrowRight size={13} color={MUTED} />
                            <span style={styles.taskRowDest}>{propertyName(t.destinationPropertyId)}</span>
                          </div>
                          <span style={styles.taskRowMeta}>{t.itemIds.length} item{t.itemIds.length === 1 ? "" : "s"}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <button style={styles.addFieldBtn} onClick={() => onAssignTask(p.id)}>
                    <ClipboardList size={13} /> Assign a move task to {p.name}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {people.length === 0 && <div style={styles.sidebarEmpty}>No one added yet.</div>}
      </div>
    </ModalShell>
  );
}

/* ---------- Confirm modal ---------- */
function ConfirmModal({ label, type, onCancel, onConfirm }) {
  const noun = type === "property" ? "property" : type === "category" ? "category" : type === "room" ? "location" : type === "task" ? "task" : "item";
  const warning =
    type === "property" ? "This will also remove every item logged under it."
    : type === "category" ? "Items in this category will move to Uncategorized, not be deleted."
    : type === "room" ? "Items with this location will show no location, not be deleted."
    : type === "task" ? "The items themselves won't be touched — only the task."
    : "This can't be undone.";
  return (
    <ModalShell onClose={onCancel} title={`Delete this ${noun}?`} width={400}>
      <p style={{ fontSize: 13.5, color: TEXT, lineHeight: 1.5 }}>
        <strong>{label}</strong> will be removed. {warning}
      </p>
      <div style={styles.formActions}>
        <button style={styles.secondaryBtn} onClick={onCancel}>Cancel</button>
        <button style={{ ...styles.primaryBtn, background: "#A64D3D" }} onClick={onConfirm}><Trash2 size={14} /> Delete</button>
      </div>
    </ModalShell>
  );
}

/* ---------- Shared bits ---------- */
/* ---------- Login ---------- */
function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const friendlyError = (code) => {
    if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
      return "That email or password isn't right.";
    }
    if (code === "auth/invalid-email") return "That doesn't look like a valid email.";
    if (code === "auth/too-many-requests") return "Too many attempts — wait a bit and try again.";
    return "Something went wrong signing in.";
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      setError(friendlyError(err.code));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.loginScreen}>
      <form style={styles.loginCard} onSubmit={handleSubmit}>
        <div style={styles.loginMark}>⌂</div>
        <div style={styles.loginTitle}>MyStuff</div>
        <div style={styles.loginSubtitle}>Sign in to see the family inventory.</div>

        <label style={styles.fieldWrap}>
          <span style={styles.fieldLabel}>Email</span>
          <div style={styles.loginInputWrap}>
            <Mail size={14} color={MUTED} />
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={styles.loginInput}
              placeholder="you@example.com"
            />
          </div>
        </label>

        <label style={styles.fieldWrap}>
          <span style={styles.fieldLabel}>Password</span>
          <div style={styles.loginInputWrap}>
            <Lock size={14} color={MUTED} />
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={styles.loginInput}
              placeholder="••••••••"
            />
          </div>
        </label>

        {error && <div style={styles.formError}><AlertCircle size={14} /> {error}</div>}

        <button type="submit" style={{ ...styles.primaryBtn, justifyContent: "center" }} disabled={busy}>
          {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />} Sign in
        </button>

        <div style={styles.loginFootnote}>
          Don't have an account yet? Ask whoever set this up to add you in the
          Firebase console.
        </div>
      </form>
    </div>
  );
}

/* ---------- Who are you? ---------- */
function WhoAreYouModal({ people, authEmail, onPick, onAddNew, onSkip }) {
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(people.length === 0);

  return (
    <ModalShell onClose={onSkip} title="Which family member are you?" width={420}>
      <p style={{ fontSize: 13, color: MUTED, marginTop: -4 }}>
        Signed in as {authEmail}. Picking your name lets items you add
        auto-fill you as the holder — you can change this later from People.
      </p>
      {!adding ? (
        <div style={styles.formGrid}>
          <div style={styles.manageList}>
            {people.map((p) => (
              <button key={p.id} style={styles.whoAreYouRow} onClick={() => onPick(p.id)}>
                <User size={14} /> {p.name}
              </button>
            ))}
          </div>
          <button style={styles.addFieldBtn} onClick={() => setAdding(true)}>
            <Plus size={13} /> I'm not on this list
          </button>
          <div style={styles.formActions}>
            <button style={styles.secondaryBtn} onClick={onSkip}>Skip for now</button>
          </div>
        </div>
      ) : (
        <div style={styles.formGrid}>
          <Field label="Your name">
            <input style={styles.input} value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus placeholder="e.g. Jordan" />
          </Field>
          <div style={styles.formActions}>
            {people.length > 0 && <button style={styles.secondaryBtn} onClick={() => setAdding(false)}>Back</button>}
            <button style={styles.primaryBtn} onClick={() => newName.trim() && onAddNew(newName.trim())}>
              <Check size={15} /> Save
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function ModalShell({ children, onClose, title, width }) {
  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={{ ...styles.modal, maxWidth: width }} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{title}</span>
          <button style={styles.iconBtn} onClick={onClose}><X size={18} /></button>
        </div>
        <div style={styles.modalBody}>{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return <label style={styles.fieldWrap}><span style={styles.fieldLabel}>{label}</span>{children}</label>;
}

function GlobalStyle() {
  return (
    <style>{`
      * { box-sizing: border-box; }
      body { margin: 0; }
      input, select, textarea, button { font-family: ${FONT_BODY}; }
      input:focus, select:focus, textarea:focus, button:focus-visible { outline: 2px solid #A67C3D; outline-offset: 1px; }
      ::placeholder { color: #A8A395; }
      .spin { animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .jiggle { animation: jiggle 0.22s ease-in-out infinite; }
      @keyframes jiggle {
        0% { transform: rotate(-1deg); }
        50% { transform: rotate(1.2deg); }
        100% { transform: rotate(-1deg); }
      }
    `}</style>
  );
}

/* ---------- Fonts ---------- */
const FONT_DISPLAY = "'Baloo 2', cursive";
const FONT_BODY = "'Nunito', -apple-system, sans-serif";
const FONT_MONO = "'IBM Plex Mono', monospace";
const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Nunito:wght@400;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap');`;
if (typeof document !== "undefined" && !document.getElementById("manifest-fonts")) {
  const style = document.createElement("style");
  style.id = "manifest-fonts";
  style.textContent = FONT_IMPORT;
  document.head.appendChild(style);
}

const INK = "#3B2A1E";
const PAPER = "#FFF1E0";
const PAPER_DARK = "#F1E0C4";
const BRASS = "#E8834A";
const TEXT = "#3B2A1E";
const MUTED = "#9C8468";
const BORDER = "#3B2A1E";

const styles = {
  app: { minHeight: "100vh", background: PAPER, color: TEXT, fontFamily: FONT_BODY },
  loadingScreen: { minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: PAPER },

  loginScreen: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: PAPER, padding: 20 },
  loginCard: {
    background: "#fff", border: `3px solid ${BORDER}`, borderRadius: 4, padding: "32px 28px",
    width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 14,
    boxShadow: "0 12px 32px rgba(30,25,15,0.08)",
  },
  loginMark: { width: 40, height: 40, borderRadius: 4, background: INK, color: BRASS, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, marginBottom: 2 },
  loginTitle: { fontFamily: FONT_DISPLAY, fontSize: 21, fontWeight: 600, color: INK },
  loginSubtitle: { fontSize: 13, color: MUTED, marginTop: -10, marginBottom: 6 },
  loginInputWrap: { display: "flex", alignItems: "center", gap: 8, border: `3px solid ${BORDER}`, borderRadius: 4, padding: "9px 11px", background: "#fff" },
  loginInput: { border: "none", outline: "none", fontSize: 13.5, background: "transparent", width: "100%" },
  loginFootnote: { fontSize: 11.5, color: MUTED, textAlign: "center", lineHeight: 1.5, marginTop: 4 },
  whoAreYouRow: {
    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
    background: "#fff", border: `3px solid ${BORDER}`, borderRadius: 4, padding: "10px 12px",
    fontSize: 13.5, color: TEXT, cursor: "pointer",
  },

  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12,
    padding: "18px 28px", borderBottom: `3px solid ${BORDER}`, background: "#FFFCF6", position: "sticky", top: 0, zIndex: 10,
  },
  brand: { display: "flex", alignItems: "center", gap: 12 },
  backBtn: {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 32, height: 32, background: "#fff", border: `3px solid ${BORDER}`,
    borderRadius: 10, cursor: "pointer", color: TEXT, flexShrink: 0, boxShadow: `2px 2px 0 ${BORDER}`,
  },
  brandMark: { width: 34, height: 34, borderRadius: 12, background: INK, color: BRASS, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 },
  brandTitle: { fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 17, color: INK },
  breadcrumb: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 2 },
  crumbBtn: { background: "transparent", border: "none", padding: 0, color: MUTED, cursor: "pointer", fontSize: 12, textDecoration: "underline" },
  crumbSep: { color: "#B9B4A4" },
  crumbCurrent: { color: TEXT, fontWeight: 600 },
  headerActions: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },

  searchBox: { display: "flex", alignItems: "center", gap: 6, background: "#fff", border: `3px solid ${BORDER}`, borderRadius: 12, padding: "7px 10px", minWidth: 190 },
  searchInput: { border: "none", outline: "none", fontSize: 13, background: "transparent", width: "100%" },
  filterSelect: { border: `3px solid ${BORDER}`, borderRadius: 12, padding: "7px 8px", fontSize: 12.5, background: "#fff", color: TEXT },

  primaryBtn: { display: "flex", alignItems: "center", gap: 6, background: BRASS, color: "#fff", border: `3px solid ${BORDER}`, borderRadius: 12, boxShadow: `3px 3px 0 ${BORDER}`, padding: "9px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  secondaryBtn: { display: "flex", alignItems: "center", gap: 6, background: "#fff", color: TEXT, border: `3px solid ${BORDER}`, borderRadius: 12, boxShadow: `3px 3px 0 ${BORDER}`, padding: "9px 13px", fontSize: 13, cursor: "pointer" },

  main: { padding: "24px 28px 56px", maxWidth: 1100, margin: "0 auto" },
  pageTitle: { fontFamily: FONT_DISPLAY, fontSize: 25, margin: 0, fontWeight: 600, color: INK },
  pageSubtitle: { fontSize: 12.5, color: MUTED, marginTop: 4, fontFamily: FONT_MONO },
  propertySectionLabel: { fontFamily: FONT_DISPLAY, fontSize: 15.5, fontWeight: 600, marginTop: 4 },

  sectionLabel: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: MUTED, margin: "18px 2px 10px" },

  collapsibleSection: { marginBottom: 12 },
  collapsibleBar: {
    display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
    background: "#fff", border: `3px solid ${BORDER}`, borderRadius: 16, padding: "14px 16px",
    cursor: "pointer", color: TEXT, boxShadow: `4px 4px 0 ${BORDER}`,
  },
  collapsibleBarLeft: { display: "flex", alignItems: "center", gap: 10 },
  collapsibleBarLabel: { fontFamily: FONT_DISPLAY, fontSize: 15.5, fontWeight: 600 },
  collapsibleBarCount: { fontFamily: FONT_MONO, fontSize: 11.5, color: MUTED, background: PAPER_DARK, padding: "2px 8px", borderRadius: 20 },
  collapsibleContent: { padding: "14px 2px 4px" },
  rearrangeBar: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
    background: PAPER_DARK, borderRadius: 4, padding: "8px 12px", marginBottom: 10, fontSize: 12.5, color: TEXT,
  },

  taskList: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 },
  taskRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
    background: "#fff", border: `3px solid ${BORDER}`, borderRadius: 4, padding: "10px 12px", cursor: "pointer",
  },
  taskRowLeft: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, flexWrap: "wrap" },
  taskRowPerson: { fontWeight: 600, color: TEXT },
  taskRowDest: { color: TEXT },
  taskRowMeta: { fontSize: 11.5, color: MUTED, fontFamily: FONT_MONO, whiteSpace: "nowrap" },

  taskItemPicker: {
    maxHeight: 220, overflowY: "auto", border: `3px solid ${BORDER}`, borderRadius: 4,
    display: "flex", flexDirection: "column",
  },
  taskItemPickerRow: {
    display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", fontSize: 13,
    borderBottom: `3px solid ${BORDER}`, cursor: "pointer",
  },
  taskItemPickerLocation: { fontSize: 11, color: MUTED, fontFamily: FONT_MONO, whiteSpace: "nowrap" },
  taskGroupProperty: { borderBottom: `3px solid ${BORDER}` },
  taskGroupBar: {
    display: "flex", alignItems: "center", gap: 8, width: "100%", background: PAPER_DARK,
    border: "none", padding: "8px 10px", fontSize: 13, color: TEXT, cursor: "pointer",
  },
  taskGroupCategory: {},
  taskGroupBarSmall: {
    display: "flex", alignItems: "center", gap: 8, width: "100%", background: "#fff",
    border: "none", padding: "6px 10px 6px 22px", fontSize: 12.5, color: TEXT, cursor: "pointer",
  },
  tileGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 14 },
  tile: {
    position: "relative", background: "#fff", border: `3px solid ${BORDER}`, borderRadius: 18,
    padding: "20px 14px 14px", boxShadow: `4px 4px 0 ${BORDER}`, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 4,
  },
  tileIconWrap: { width: 52, height: 52, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 6 },
  tileName: { fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 14.5, color: INK },
  tileMeta: { fontSize: 11, color: MUTED, fontFamily: FONT_MONO },
  tileActions: { position: "absolute", top: 8, right: 8, display: "flex", gap: 2 },
  tileIconBtn: { background: "#FFFCF6", border: `3px solid ${BORDER}`, borderRadius: 8, padding: 4, cursor: "pointer", color: MUTED, display: "flex" },
  addTile: {
    display: "flex", alignItems: "center", gap: 6, background: "transparent", border: `3px dashed ${BORDER}`,
    borderRadius: 14, padding: "10px 16px", fontSize: 13, color: MUTED, cursor: "pointer", marginTop: 16,
  },

  itemListHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 10, marginBottom: 16 },
  subFilterRow: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 },
  subFilterChip: {
    background: "#fff", border: `3px solid ${BORDER}`, borderRadius: 20, padding: "5px 12px",
    fontSize: 12, color: TEXT, cursor: "pointer",
  },
  subFilterChipActive: { background: INK, color: "#F2EFE6", borderColor: INK },
  cardGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 14 },

  itemTileGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))", gap: 10 },
  itemCompactTile: {
    background: "#fff", border: `3px solid ${BORDER}`, borderRadius: 14, padding: "10px 8px",
    cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 5, boxShadow: `3px 3px 0 ${BORDER}`,
  },
  itemCompactPhoto: { width: "100%", height: 64, objectFit: "cover", borderRadius: 3, marginBottom: 2 },
  itemCompactName: { fontSize: 12.5, fontWeight: 600, color: TEXT, lineHeight: 1.3, wordBreak: "break-word" },
  itemCompactLocation: { fontSize: 10, color: MUTED, fontFamily: FONT_MONO },

  detailPhoto: { width: "100%", maxHeight: 220, objectFit: "cover", borderRadius: 4, border: `3px solid ${BORDER}` },
  detailRow: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13.5, padding: "2px 0" },
  detailLabel: { color: MUTED },
  detailValue: { color: TEXT, fontWeight: 500 },

  tagCard: { position: "relative", background: "#fff", border: `3px solid ${BORDER}`, borderRadius: 4, boxShadow: "0 1px 2px rgba(30,25,15,0.06)", overflow: "hidden" },
  tagPhoto: { width: "100%", height: 130, objectFit: "cover", display: "block", borderBottom: `3px solid ${BORDER}` },
  photoPreviewWrap: { display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" },
  photoPreview: { width: 140, height: 105, objectFit: "cover", borderRadius: 4, border: `3px solid ${BORDER}` },
  tagHole: { position: "absolute", top: 12, left: 12, width: 10, height: 10, borderRadius: "50%", border: `2px solid ${BRASS}`, background: PAPER },
  tagBody: { padding: "14px 14px 12px 32px" },
  tagTopRow: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 6 },
  tagName: { fontFamily: FONT_DISPLAY, fontSize: 15.5, fontWeight: 600, color: INK, lineHeight: 1.25 },
  tagActions: { display: "flex", gap: 2 },
  iconBtn: { background: "transparent", border: "none", color: MUTED, cursor: "pointer", padding: 4, borderRadius: 3, display: "flex" },
  tagCategory: { display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, marginTop: 5, fontWeight: 500, color: BRASS },
  customFieldList: { marginTop: 8, display: "flex", flexDirection: "column", gap: 3 },
  customField: { display: "flex", justifyContent: "space-between", fontSize: 11.5, fontFamily: FONT_MONO, color: "#5A5648" },
  customFieldKey: { color: MUTED },
  customFieldVal: { color: TEXT },
  tagNotes: { fontSize: 12, color: "#5A5648", marginTop: 8, lineHeight: 1.4 },
  tagPerforation: { borderTop: `3px dashed ${BORDER}`, margin: "12px -14px 10px -32px" },
  tagStub: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  tagStubRow: { display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: TEXT, fontWeight: 500 },
  tagQty: { fontFamily: FONT_MONO, fontSize: 12, color: MUTED, fontWeight: 600 },

  emptyState: { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "60px 20px", gap: 8, maxWidth: 340, margin: "20px auto" },
  emptyIcon: { width: 56, height: 56, borderRadius: "50%", background: PAPER_DARK, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 6 },
  emptyTitle: { fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 600 },
  emptyBody: { fontSize: 13, color: MUTED, lineHeight: 1.5, marginBottom: 8 },

  modalOverlay: { position: "fixed", inset: 0, background: "rgba(20,18,12,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 },
  modal: { background: "#FFFCF6", borderRadius: 20, width: "100%", maxHeight: "88vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 50px rgba(0,0,0,0.25)" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: `3px solid ${BORDER}` },
  modalTitle: { fontFamily: FONT_DISPLAY, fontSize: 17, fontWeight: 600 },
  modalBody: { padding: 20, overflowY: "auto" },

  formGrid: { display: "flex", flexDirection: "column", gap: 14 },
  formRow2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  fieldWrap: { display: "flex", flexDirection: "column", gap: 5 },
  fieldLabel: { fontSize: 11.5, letterSpacing: 0.3, color: MUTED, textTransform: "uppercase", fontWeight: 600 },
  input: { border: `3px solid ${BORDER}`, borderRadius: 10, padding: "9px 11px", fontSize: 13.5, background: "#fff", color: TEXT, width: "100%" },
  customFieldRow: { display: "flex", gap: 6, marginBottom: 6, alignItems: "center" },
  addFieldBtn: { display: "flex", alignItems: "center", gap: 5, background: "transparent", border: `3px dashed ${BORDER}`, borderRadius: 3, padding: "6px 10px", fontSize: 12, color: MUTED, cursor: "pointer", marginTop: 2 },
  formError: { display: "flex", alignItems: "center", gap: 6, color: "#A64D3D", fontSize: 12.5 },
  formActions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 },

  typeToggle: { display: "flex", alignItems: "center", gap: 6, border: `3px solid ${BORDER}`, borderRadius: 4, padding: "8px 12px", background: "#fff", color: TEXT, cursor: "pointer", fontSize: 13 },
  typeToggleActive: { background: INK, color: "#F2EFE6", borderColor: INK },

  addRow: { display: "flex", gap: 8, marginBottom: 12 },
  manageList: { display: "flex", flexDirection: "column", gap: 6 },
  manageItemRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 4px", borderBottom: `3px solid ${BORDER}` },
  personBlock: {},
  personNameBtn: {
    display: "flex", alignItems: "center", gap: 8, background: "transparent", border: "none",
    cursor: "pointer", fontSize: 13.5, color: TEXT, padding: "4px 0", flex: 1, textAlign: "left",
  },
  personExpanded: { padding: "4px 4px 12px 22px", display: "flex", flexDirection: "column", gap: 8 },
  sidebarEmpty: { fontSize: 12, color: MUTED, padding: "6px 4px" },
};
