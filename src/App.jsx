import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Home, Warehouse, Plus, X, Search, User, Package, Sofa, Palette,
  UtensilsCrossed, Dumbbell, Shirt, BookOpen, Tv, Wrench, Box,
  Trash2, Edit3, Tag, Loader2, AlertCircle, Check, Camera,
  LogOut, Mail, Lock, Image as ImageIcon, ImageOff, ChevronDown, ChevronRight, ChevronLeft,
  ClipboardList, ArrowRight, CheckCircle2
} from "lucide-react";
import { db, auth } from "./firebase";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";

// All family data lives in a single Firestore document. Every device that
// has this app open gets pushed live updates via onSnapshot.
const MANIFEST_DOC = doc(db, "manifest", "household");

const TILE_COLORS = ["#2E7A83", "#0F3B4D", "#E8A33D", "#6E9B8C", "#3F5F73", "#4C93A0", "#C98A2E", "#557A85"];

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

  // view: 'home' | 'property' | 'category'
  const [view, setView] = useState("home");
  const [selectedPropertyId, setSelectedPropertyId] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState(null); // "" means uncategorized

  const [homeSearch, setHomeSearch] = useState("");

  const [propertyModal, setPropertyModal] = useState(null); // { mode:'create'|'edit', property? }
  const [categoryModal, setCategoryModal] = useState(null); // { mode, category? }
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
    };
    window.history.pushState(state, "");
    setView(state.view);
    setSelectedPropertyId(state.selectedPropertyId);
    setSelectedCategory(state.selectedCategory);
  };

  const closeAllModals = () => {
    setPropertyModal(null);
    setCategoryModal(null);
    setPeopleModal(false);
    setItemModal(null);
    setItemDetail(null);
    setTaskModal(null);
    setTaskDetail(null);
    setConfirmDelete(null);
    setWhoAreYouOpen(false);
  };

  const anyModalOpen = !!(
    propertyModal || categoryModal || peopleModal || itemModal || itemDetail ||
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
    window.history.replaceState({ view: "home", selectedPropertyId: null, selectedCategory: null }, "");
    const onPopState = (e) => {
      if (modalHistoryRef.current) {
        modalHistoryRef.current = false;
        closeAllModals();
        return;
      }
      const s = e.state || { view: "home", selectedPropertyId: null, selectedCategory: null };
      setView(s.view);
      setSelectedPropertyId(s.selectedPropertyId);
      setSelectedCategory(s.selectedCategory);
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

  const categoriesInProperty = useMemo(() => {
    if (!selectedPropertyId) return { list: [], hasUncategorized: false };
    const hasUncategorized = items.some((it) => it.propertyId === selectedPropertyId && !it.category);
    return { list: categories, hasUncategorized };
  }, [items, categories, selectedPropertyId]);

  const currentItems = useMemo(() => {
    if (view === "category" && selectedPropertyId) {
      return items.filter(
        (it) => it.propertyId === selectedPropertyId && (it.category || "") === (selectedCategory || "")
      );
    }
    if (view === "globalCategory") {
      return items.filter((it) => (it.category || "") === (selectedCategory || ""));
    }
    return [];
  }, [items, view, selectedPropertyId, selectedCategory]);

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
      return { ...d, properties: [...d.properties, { id: uid(), name, type }] };
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
          categories: d.categories.map((c) => (c === oldName ? name : c)),
          items: d.items.map((it) => (it.category === oldName ? { ...it, category: name } : it)),
        };
      }
      if (d.categories.includes(name)) return d;
      return { ...d, categories: [...d.categories, name] };
    });
  };
  const deleteCategory = (name) => {
    setData((d) => ({
      ...d,
      categories: d.categories.filter((c) => c !== name),
      items: d.items.map((it) => (it.category === name ? { ...it, category: "" } : it)),
    }));
    if (selectedCategory === name) pushView(selectedPropertyId ? { view: "property", selectedPropertyId } : { view: "home" });
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
      items: d.items.map((it) => (it.holderId === id ? { ...it, holderId: null } : it)),
    }));
  };

  const upsertItem = (item) => {
    setData((d) => ({
      ...d,
      categories: item.category && !d.categories.includes(item.category) ? [...d.categories, item.category] : d.categories,
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
        <Loader2 className="spin" size={28} color="#A67C3D" />
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
        <Loader2 className="spin" size={28} color="#A67C3D" />
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
                onHome={() => pushView({ view: "home" })}
                onProperty={() => pushView({ view: "property", selectedPropertyId })}
              />
            )}
          </div>
        </div>
        <div style={styles.headerActions}>
          {view === "home" && (
            <div style={styles.searchBox}>
              <Search size={14} color="#8A8577" />
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
            personName={personName}
            onEdit={(it) => setItemModal({ mode: "edit", item: it })}
            onDelete={(it) => setConfirmDelete({ type: "item", id: it.id, label: it.name })}
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
          />
        ) : (view === "category" || view === "globalCategory") ? (
          <CategoryView
            property={selectedProperty}
            category={selectedCategory}
            items={currentItems}
            personName={personName}
            propertyName={propertyName}
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
          existing={categories}
          onClose={() => setCategoryModal(null)}
          onSave={(name, oldName) => { saveCategory(name, oldName); setCategoryModal(null); }}
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
function Breadcrumb({ property, category, onHome, onProperty }) {
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
    </div>
  );
}

/* ---------- Home: collapsible sections ---------- */
function HomeView({
  properties, categories,
  itemCountForProperty, itemCountForCategoryGlobal, hasGlobalUncategorized,
  onOpen, onEdit, onDelete, onAdd, onOpenGlobalCategory,
}) {
  const houses = properties.filter((p) => p.type === "house");
  const storage = properties.filter((p) => p.type === "storage");
  const [openSections, setOpenSections] = useState({ houses: false, storage: false, categories: false });
  const toggle = (key) => setOpenSections((s) => ({ ...s, [key]: !s[key] }));

  if (properties.length === 0) {
    return (
      <EmptyState
        icon={<Home size={30} color="#A67C3D" />}
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
          <TileGrid>
            {houses.map((p) => (
              <PropertyTile key={p.id} property={p} colorIndex={properties.indexOf(p)}
                count={itemCountForProperty(p.id)} onOpen={() => onOpen(p.id)}
                onEdit={() => onEdit(p)} onDelete={() => onDelete(p)} />
            ))}
          </TileGrid>
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
          <TileGrid>
            {storage.map((p) => (
              <PropertyTile key={p.id} property={p} colorIndex={properties.indexOf(p)}
                count={itemCountForProperty(p.id)} onOpen={() => onOpen(p.id)}
                onEdit={() => onEdit(p)} onDelete={() => onDelete(p)} />
            ))}
          </TileGrid>
        </CollapsibleSection>
      )}

      {(categories.length > 0 || hasGlobalUncategorized) && (
        <CollapsibleSection
          icon={<Tag size={15} />}
          label="Item categories"
          count={categories.length + (hasGlobalUncategorized ? 1 : 0)}
          open={openSections.categories}
          onToggle={() => toggle("categories")}
        >
          <div style={styles.pageSubtitle}>See everything in a category, across every property.</div>
          <TileGrid>
            {categories.map((cat, i) => {
              const Icon = categoryIcon(cat);
              const color = TILE_COLORS[i % TILE_COLORS.length];
              const count = itemCountForCategoryGlobal(cat);
              return (
                <div key={cat} style={styles.tile} onClick={() => onOpenGlobalCategory(cat)}>
                  <div style={{ ...styles.tileIconWrap, background: color + "22", color }}><Icon size={26} /></div>
                  <div style={styles.tileName}>{cat}</div>
                  <div style={styles.tileMeta}>{count} item{count === 1 ? "" : "s"}</div>
                </div>
              );
            })}
            {hasGlobalUncategorized && (
              <div style={styles.tile} onClick={() => onOpenGlobalCategory("")}>
                <div style={{ ...styles.tileIconWrap, background: "#8A857722", color: "#8A8577" }}><Box size={26} /></div>
                <div style={styles.tileName}>Uncategorized</div>
                <div style={styles.tileMeta}>{itemCountForCategoryGlobal("")} item{itemCountForCategoryGlobal("") === 1 ? "" : "s"}</div>
              </div>
            )}
          </TileGrid>
        </CollapsibleSection>
      )}

      <button style={styles.addTile} onClick={onAdd}>
        <Plus size={16} /> Add a property
      </button>
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

function PropertyTile({ property, colorIndex, count, onOpen, onEdit, onDelete }) {
  const color = TILE_COLORS[colorIndex % TILE_COLORS.length];
  const Icon = property.type === "house" ? Home : Warehouse;
  return (
    <div style={styles.tile} onClick={onOpen}>
      <div style={{ ...styles.tileIconWrap, background: color + "22", color }}>
        <Icon size={26} />
      </div>
      <div style={styles.tileName}>{property.name}</div>
      <div style={styles.tileMeta}>{count} item{count === 1 ? "" : "s"}</div>
      <div style={styles.tileActions}>
        <button style={styles.tileIconBtn} onClick={(e) => { e.stopPropagation(); onEdit(); }}><Edit3 size={13} /></button>
        <button style={styles.tileIconBtn} onClick={(e) => { e.stopPropagation(); onDelete(); }}><Trash2 size={13} /></button>
      </div>
    </div>
  );
}

/* ---------- Property view: category grid ---------- */
function PropertyView({ property, categories, hasUncategorized, itemCountForCategory, onOpenCategory, onEditCategory, onDeleteCategory, onAddCategory }) {
  return (
    <div>
      <h1 style={styles.pageTitle}>{property.name}</h1>
      <div style={styles.pageSubtitle}>Choose a category to see what's logged there</div>
      <TileGrid>
        {categories.map((cat, i) => {
          const Icon = categoryIcon(cat);
          const color = TILE_COLORS[i % TILE_COLORS.length];
          return (
            <div key={cat} style={styles.tile} onClick={() => onOpenCategory(cat)}>
              <div style={{ ...styles.tileIconWrap, background: color + "22", color }}><Icon size={26} /></div>
              <div style={styles.tileName}>{cat}</div>
              <div style={styles.tileMeta}>{itemCountForCategory(cat)} item{itemCountForCategory(cat) === 1 ? "" : "s"}</div>
              <div style={styles.tileActions}>
                <button style={styles.tileIconBtn} onClick={(e) => { e.stopPropagation(); onEditCategory(cat); }}><Edit3 size={13} /></button>
                <button style={styles.tileIconBtn} onClick={(e) => { e.stopPropagation(); onDeleteCategory(cat); }}><Trash2 size={13} /></button>
              </div>
            </div>
          );
        })}
        {hasUncategorized && (
          <div style={styles.tile} onClick={() => onOpenCategory("")}>
            <div style={{ ...styles.tileIconWrap, background: "#8A857722", color: "#8A8577" }}><Box size={26} /></div>
            <div style={styles.tileName}>Uncategorized</div>
            <div style={styles.tileMeta}>{itemCountForCategory("")} item{itemCountForCategory("") === 1 ? "" : "s"}</div>
          </div>
        )}
      </TileGrid>
      <button style={styles.addTile} onClick={onAddCategory}>
        <Plus size={16} /> Add a category
      </button>
    </div>
  );
}

/* ---------- Category view: item list ---------- */
function CategoryView({ property, category, items, personName, propertyName, onAddItem, onOpenItem }) {
  const hasPhotos = items.some((it) => it.photo);
  const [showPhotos, setShowPhotos] = useState(true);

  return (
    <div>
      <div style={styles.itemListHeader}>
        <div>
          <h1 style={styles.pageTitle}>{category || "Uncategorized"}</h1>
          <div style={styles.pageSubtitle}>
            {property ? property.name : "All properties"} · {items.length} item{items.length === 1 ? "" : "s"}
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
      {items.length === 0 ? (
        <EmptyState
          icon={<Package size={30} color="#A67C3D" />}
          title="Nothing logged here yet"
          body="Add the first item to this category."
          actionLabel="Log an item"
          onAction={onAddItem}
        />
      ) : (
        <div style={styles.itemTileGrid}>
          {items.map((it) => (
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
function SearchResultsView({ results, propertyName, personName, onEdit, onDelete }) {
  return (
    <div>
      <div style={styles.pageSubtitle}>{results.length} result{results.length === 1 ? "" : "s"}</div>
      {results.length === 0 ? (
        <EmptyState icon={<Search size={26} color="#A67C3D" />} title="No matches" body="Try a different search term or clear the filter." />
      ) : (
        <div style={{ ...styles.cardGrid, marginTop: 14 }}>
          {results.map((it) => (
            <ItemTag key={it.id} item={it} holderName={personName(it.holderId)}
              locationLabel={propertyName(it.propertyId)}
              onEdit={() => onEdit(it)} onDelete={() => onDelete(it)} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Item tag card ---------- */
function ItemTag({ item, holderName, locationLabel, showPhoto = true, onEdit, onDelete }) {
  const displayPhoto = showPhoto && !!item.photo;
  return (
    <div style={styles.tagCard}>
      {displayPhoto && (
        <img src={item.photo} alt={item.name} style={styles.tagPhoto} />
      )}
      {!displayPhoto && <div style={styles.tagHole} />}
      <div style={displayPhoto ? { ...styles.tagBody, paddingLeft: 14 } : styles.tagBody}>
        <div style={styles.tagTopRow}>
          <span style={styles.tagName}>{item.name}</span>
          <div style={styles.tagActions}>
            <button style={styles.iconBtn} onClick={onEdit} title="Edit"><Edit3 size={13} /></button>
            <button style={styles.iconBtn} onClick={onDelete} title="Remove"><Trash2 size={13} /></button>
          </div>
        </div>
        {locationLabel && (
          <div style={styles.tagCategory}><Tag size={11} /> {locationLabel}{item.category ? ` · ${item.category}` : ""}</div>
        )}
        {item.customFields?.length > 0 && (
          <div style={styles.customFieldList}>
            {item.customFields.map((f, i) => f.key ? (
              <div key={i} style={styles.customField}>
                <span style={styles.customFieldKey}>{f.key}</span>
                <span style={styles.customFieldVal}>{f.value}</span>
              </div>
            ) : null)}
          </div>
        )}
        {item.notes && <div style={styles.tagNotes}>{item.notes}</div>}
        <div style={styles.tagPerforation} />
        <div style={styles.tagStub}>
          <div style={styles.tagStubRow}><User size={12} /><span>{holderName || "In storage"}</span></div>
          <div style={styles.tagQty}>Qty: {item.quantity || 1}</div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Item detail popup ---------- */
function ItemDetailModal({ item, propertyName, personName, showLocation, onClose, onEdit, onDelete }) {
  if (!item) return null;
  return (
    <ModalShell onClose={onClose} title={item.name} width={460}>
      <div style={styles.formGrid}>
        {item.photo && <img src={item.photo} alt={item.name} style={styles.detailPhoto} />}

        <div style={styles.detailRow}>
          <span style={styles.detailLabel}>Quantity</span>
          <span style={styles.detailValue}>{item.quantity || 1}</span>
        </div>
        <div style={styles.detailRow}>
          <span style={styles.detailLabel}>In the possession of</span>
          <span style={styles.detailValue}>{personName(item.holderId) || "In storage"}</span>
        </div>
        {showLocation && (
          <div style={styles.detailRow}>
            <span style={styles.detailLabel}>Property</span>
            <span style={styles.detailValue}>{propertyName(item.propertyId)}</span>
          </div>
        )}
        <div style={styles.detailRow}>
          <span style={styles.detailLabel}>Category</span>
          <span style={styles.detailValue}>{item.category || "Uncategorized"}</span>
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
  const [itemIds, setItemIds] = useState(task?.itemIds || []);
  const [notes, setNotes] = useState(task?.notes || "");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");

  const candidateItems = useMemo(() => {
    return items
      .filter((it) => it.propertyId !== destinationPropertyId || itemIds.includes(it.id))
      .filter((it) => !search.trim() || it.name.toLowerCase().includes(search.trim().toLowerCase()));
  }, [items, destinationPropertyId, itemIds, search]);

  const toggleItem = (id) => {
    setItemIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };

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
          <Field label="Assign to">
            <select style={styles.input} value={personId} onChange={(e) => setPersonId(e.target.value)}>
              {people.length === 0 && <option value="">Add a person first</option>}
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Move to">
            <select style={styles.input} value={destinationPropertyId} onChange={(e) => setDestinationPropertyId(e.target.value)}>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        </div>

        <Field label={`Items to move (${itemIds.length} selected)`}>
          <input
            style={{ ...styles.input, marginBottom: 6 }}
            placeholder="Search items…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div style={styles.taskItemPicker}>
            {candidateItems.length === 0 && (
              <div style={{ fontSize: 12.5, color: MUTED, padding: "8px 4px" }}>No matching items.</div>
            )}
            {candidateItems.map((it) => (
              <label key={it.id} style={styles.taskItemPickerRow}>
                <input type="checkbox" checked={itemIds.includes(it.id)} onChange={() => toggleItem(it.id)} />
                <span style={{ flex: 1 }}>{it.name}</span>
                <span style={styles.taskItemPickerLocation}>{propertyName(it.propertyId)}</span>
              </label>
            ))}
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
function ItemFormModal({ item, properties, people, categories, defaultPropertyId, defaultCategory, onClose, onSave }) {
  const [name, setName] = useState(item?.name || "");
  const [propertyId, setPropertyId] = useState(item?.propertyId || defaultPropertyId || properties[0]?.id || "");
  const [category, setCategory] = useState(item?.category ?? defaultCategory ?? "");
  const [newCategory, setNewCategory] = useState("");
  const [addingCategory, setAddingCategory] = useState(false);
  const [holderId, setHolderId] = useState(item?.holderId ?? "");
  const [quantity, setQuantity] = useState(item?.quantity ?? 1);
  const [notes, setNotes] = useState(item?.notes || "");
  const [customFields, setCustomFields] = useState(item?.customFields?.length ? item.customFields : [{ key: "", value: "" }]);
  const [photo, setPhoto] = useState(item?.photo || null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);

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
    }
  };

  const handleSave = () => {
    if (!name.trim()) return setError("Give the item a name.");
    if (!propertyId) return setError("Choose a property.");
    if (addingCategory && !newCategory.trim()) return setError("Type a name for the new category, or cancel it.");
    const finalCategory = addingCategory ? newCategory.trim() : category;
    onSave({
      id: item?.id || uid(),
      name: name.trim(),
      propertyId,
      category: finalCategory,
      holderId: holderId || null,
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
            <button
              style={styles.secondaryBtn}
              type="button"
              disabled={photoBusy}
              onClick={() => fileInputRef.current?.click()}
            >
              {photoBusy ? <Loader2 size={14} className="spin" /> : <Camera size={14} />}
              {photoBusy ? "Processing…" : "Add a photo"}
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
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
            <select style={styles.input} value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Category">
            {!addingCategory ? (
              <select style={styles.input} value={category} onChange={(e) => {
                if (e.target.value === "__new__") { setAddingCategory(true); }
                else setCategory(e.target.value);
              }}>
                <option value="">Uncategorized</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
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

        <Field label="In the possession of">
          <select style={styles.input} value={holderId} onChange={(e) => setHolderId(e.target.value)}>
            <option value="">— In storage, no one —</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>

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

/* ---------- Category modal ---------- */
function CategoryModal({ initial, existing, onClose, onSave }) {
  const [name, setName] = useState(initial || "");
  const [error, setError] = useState("");
  return (
    <ModalShell onClose={onClose} title={initial !== undefined ? "Rename category" : "Add a category"} width={400}>
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
  const noun = type === "property" ? "property" : type === "category" ? "category" : type === "task" ? "task" : "item";
  const warning =
    type === "property" ? "This will also remove every item logged under it."
    : type === "category" ? "Items in this category will move to Uncategorized, not be deleted."
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
    `}</style>
  );
}

/* ---------- Fonts ---------- */
const FONT_DISPLAY = "'Fraunces', Georgia, serif";
const FONT_BODY = "'IBM Plex Sans', -apple-system, sans-serif";
const FONT_MONO = "'IBM Plex Mono', monospace";
const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');`;
if (typeof document !== "undefined" && !document.getElementById("manifest-fonts")) {
  const style = document.createElement("style");
  style.id = "manifest-fonts";
  style.textContent = FONT_IMPORT;
  document.head.appendChild(style);
}

const INK = "#0F3B4D";
const PAPER = "#F3F6F5";
const PAPER_DARK = "#E4EAE9";
const BRASS = "#E8A33D";
const TEXT = "#16303B";
const MUTED = "#6E828A";
const BORDER = "#DCE3E2";

const styles = {
  app: { minHeight: "100vh", background: PAPER, color: TEXT, fontFamily: FONT_BODY },
  loadingScreen: { minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: PAPER },

  loginScreen: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: PAPER, padding: 20 },
  loginCard: {
    background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 4, padding: "32px 28px",
    width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 14,
    boxShadow: "0 12px 32px rgba(30,25,15,0.08)",
  },
  loginMark: { width: 40, height: 40, borderRadius: 4, background: INK, color: BRASS, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, marginBottom: 2 },
  loginTitle: { fontFamily: FONT_DISPLAY, fontSize: 21, fontWeight: 600, color: INK },
  loginSubtitle: { fontSize: 13, color: MUTED, marginTop: -10, marginBottom: 6 },
  loginInputWrap: { display: "flex", alignItems: "center", gap: 8, border: `1px solid ${BORDER}`, borderRadius: 4, padding: "9px 11px", background: "#fff" },
  loginInput: { border: "none", outline: "none", fontSize: 13.5, background: "transparent", width: "100%" },
  loginFootnote: { fontSize: 11.5, color: MUTED, textAlign: "center", lineHeight: 1.5, marginTop: 4 },
  whoAreYouRow: {
    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
    background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 4, padding: "10px 12px",
    fontSize: 13.5, color: TEXT, cursor: "pointer",
  },

  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12,
    padding: "18px 28px", borderBottom: `1px solid ${BORDER}`, background: "#F2F0E7", position: "sticky", top: 0, zIndex: 10,
  },
  brand: { display: "flex", alignItems: "center", gap: 12 },
  backBtn: {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 32, height: 32, background: "#fff", border: `1px solid ${BORDER}`,
    borderRadius: 4, cursor: "pointer", color: TEXT, flexShrink: 0,
  },
  brandMark: { width: 34, height: 34, borderRadius: 4, background: INK, color: BRASS, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 },
  brandTitle: { fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 17, color: INK },
  breadcrumb: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 2 },
  crumbBtn: { background: "transparent", border: "none", padding: 0, color: MUTED, cursor: "pointer", fontSize: 12, textDecoration: "underline" },
  crumbSep: { color: "#B9B4A4" },
  crumbCurrent: { color: TEXT, fontWeight: 600 },
  headerActions: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },

  searchBox: { display: "flex", alignItems: "center", gap: 6, background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 4, padding: "7px 10px", minWidth: 190 },
  searchInput: { border: "none", outline: "none", fontSize: 13, background: "transparent", width: "100%" },
  filterSelect: { border: `1px solid ${BORDER}`, borderRadius: 4, padding: "7px 8px", fontSize: 12.5, background: "#fff", color: TEXT },

  primaryBtn: { display: "flex", alignItems: "center", gap: 6, background: INK, color: "#F2EFE6", border: "none", borderRadius: 4, padding: "9px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  secondaryBtn: { display: "flex", alignItems: "center", gap: 6, background: "#fff", color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 4, padding: "9px 13px", fontSize: 13, cursor: "pointer" },

  main: { padding: "24px 28px 56px", maxWidth: 1100, margin: "0 auto" },
  pageTitle: { fontFamily: FONT_DISPLAY, fontSize: 25, margin: 0, fontWeight: 600, color: INK },
  pageSubtitle: { fontSize: 12.5, color: MUTED, marginTop: 4, fontFamily: FONT_MONO },

  sectionLabel: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: MUTED, margin: "18px 2px 10px" },

  collapsibleSection: { marginBottom: 12 },
  collapsibleBar: {
    display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
    background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 4, padding: "14px 16px",
    cursor: "pointer", color: TEXT,
  },
  collapsibleBarLeft: { display: "flex", alignItems: "center", gap: 10 },
  collapsibleBarLabel: { fontFamily: FONT_DISPLAY, fontSize: 15.5, fontWeight: 600 },
  collapsibleBarCount: { fontFamily: FONT_MONO, fontSize: 11.5, color: MUTED, background: PAPER_DARK, padding: "2px 8px", borderRadius: 20 },
  collapsibleContent: { padding: "14px 2px 4px" },

  taskList: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 },
  taskRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
    background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 4, padding: "10px 12px", cursor: "pointer",
  },
  taskRowLeft: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, flexWrap: "wrap" },
  taskRowPerson: { fontWeight: 600, color: TEXT },
  taskRowDest: { color: TEXT },
  taskRowMeta: { fontSize: 11.5, color: MUTED, fontFamily: FONT_MONO, whiteSpace: "nowrap" },

  taskItemPicker: {
    maxHeight: 220, overflowY: "auto", border: `1px solid ${BORDER}`, borderRadius: 4,
    display: "flex", flexDirection: "column",
  },
  taskItemPickerRow: {
    display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", fontSize: 13,
    borderBottom: `1px solid ${BORDER}`, cursor: "pointer",
  },
  taskItemPickerLocation: { fontSize: 11, color: MUTED, fontFamily: FONT_MONO, whiteSpace: "nowrap" },
  tileGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 14 },
  tile: {
    position: "relative", background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 3,
    padding: "20px 14px 14px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 4,
  },
  tileIconWrap: { width: 52, height: 52, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 6 },
  tileName: { fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 14.5, color: INK },
  tileMeta: { fontSize: 11, color: MUTED, fontFamily: FONT_MONO },
  tileActions: { position: "absolute", top: 8, right: 8, display: "flex", gap: 2 },
  tileIconBtn: { background: "#F2F0E7", border: `1px solid ${BORDER}`, borderRadius: 3, padding: 4, cursor: "pointer", color: MUTED, display: "flex" },
  addTile: {
    display: "flex", alignItems: "center", gap: 6, background: "transparent", border: `1px dashed ${BORDER}`,
    borderRadius: 4, padding: "10px 16px", fontSize: 13, color: MUTED, cursor: "pointer", marginTop: 16,
  },

  itemListHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 10, marginBottom: 16 },
  cardGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 14 },

  itemTileGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))", gap: 10 },
  itemCompactTile: {
    background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 4, padding: "10px 8px",
    cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 5,
  },
  itemCompactPhoto: { width: "100%", height: 64, objectFit: "cover", borderRadius: 3, marginBottom: 2 },
  itemCompactName: { fontSize: 12.5, fontWeight: 600, color: TEXT, lineHeight: 1.3, wordBreak: "break-word" },
  itemCompactLocation: { fontSize: 10, color: MUTED, fontFamily: FONT_MONO },

  detailPhoto: { width: "100%", maxHeight: 220, objectFit: "cover", borderRadius: 4, border: `1px solid ${BORDER}` },
  detailRow: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13.5, padding: "2px 0" },
  detailLabel: { color: MUTED },
  detailValue: { color: TEXT, fontWeight: 500 },

  tagCard: { position: "relative", background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 4, boxShadow: "0 1px 2px rgba(30,25,15,0.06)", overflow: "hidden" },
  tagPhoto: { width: "100%", height: 130, objectFit: "cover", display: "block", borderBottom: `1px solid ${BORDER}` },
  photoPreviewWrap: { display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" },
  photoPreview: { width: 140, height: 105, objectFit: "cover", borderRadius: 4, border: `1px solid ${BORDER}` },
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
  tagPerforation: { borderTop: `1px dashed ${BORDER}`, margin: "12px -14px 10px -32px" },
  tagStub: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  tagStubRow: { display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: TEXT, fontWeight: 500 },
  tagQty: { fontFamily: FONT_MONO, fontSize: 12, color: MUTED, fontWeight: 600 },

  emptyState: { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "60px 20px", gap: 8, maxWidth: 340, margin: "20px auto" },
  emptyIcon: { width: 56, height: 56, borderRadius: "50%", background: PAPER_DARK, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 6 },
  emptyTitle: { fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 600 },
  emptyBody: { fontSize: 13, color: MUTED, lineHeight: 1.5, marginBottom: 8 },

  modalOverlay: { position: "fixed", inset: 0, background: "rgba(20,18,12,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 },
  modal: { background: PAPER, borderRadius: 4, width: "100%", maxHeight: "88vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 50px rgba(0,0,0,0.25)" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: `1px solid ${BORDER}` },
  modalTitle: { fontFamily: FONT_DISPLAY, fontSize: 17, fontWeight: 600 },
  modalBody: { padding: 20, overflowY: "auto" },

  formGrid: { display: "flex", flexDirection: "column", gap: 14 },
  formRow2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  fieldWrap: { display: "flex", flexDirection: "column", gap: 5 },
  fieldLabel: { fontSize: 11.5, letterSpacing: 0.3, color: MUTED, textTransform: "uppercase", fontWeight: 600 },
  input: { border: `1px solid ${BORDER}`, borderRadius: 4, padding: "9px 11px", fontSize: 13.5, background: "#fff", color: TEXT, width: "100%" },
  customFieldRow: { display: "flex", gap: 6, marginBottom: 6, alignItems: "center" },
  addFieldBtn: { display: "flex", alignItems: "center", gap: 5, background: "transparent", border: `1px dashed ${BORDER}`, borderRadius: 3, padding: "6px 10px", fontSize: 12, color: MUTED, cursor: "pointer", marginTop: 2 },
  formError: { display: "flex", alignItems: "center", gap: 6, color: "#A64D3D", fontSize: 12.5 },
  formActions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 },

  typeToggle: { display: "flex", alignItems: "center", gap: 6, border: `1px solid ${BORDER}`, borderRadius: 4, padding: "8px 12px", background: "#fff", color: TEXT, cursor: "pointer", fontSize: 13 },
  typeToggleActive: { background: INK, color: "#F2EFE6", borderColor: INK },

  addRow: { display: "flex", gap: 8, marginBottom: 12 },
  manageList: { display: "flex", flexDirection: "column", gap: 6 },
  manageItemRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 4px", borderBottom: `1px solid ${BORDER}` },
  personBlock: {},
  personNameBtn: {
    display: "flex", alignItems: "center", gap: 8, background: "transparent", border: "none",
    cursor: "pointer", fontSize: 13.5, color: TEXT, padding: "4px 0", flex: 1, textAlign: "left",
  },
  personExpanded: { padding: "4px 4px 12px 22px", display: "flex", flexDirection: "column", gap: 8 },
  sidebarEmpty: { fontSize: 12, color: MUTED, padding: "6px 4px" },
};
