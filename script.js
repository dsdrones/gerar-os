// ============================================
// CONFIGURAÇÃO DO FIREBASE
// ============================================
const firebaseConfig = {
    apiKey: "AIzaSyBydEyUgO4QSwB6o3OxHn33vp22XFc5tKU",
    authDomain: "sistemafazendas.firebaseapp.com",
    databaseURL: "https://sistemafazendas-default-rtdb.firebaseio.com",
    projectId: "sistemafazendas",
    storageBucket: "sistemafazendas.firebasestorage.app",
    messagingSenderId: "155248754394",
    appId: "1:155248754394:web:cf6a4733c32ed3bc7f6fe3",
    measurementId: "G-VNZRBCNM3D"
};

// Inicializa o App Principal
const app = firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Inicializa o App Secundário (Para criar contas de cliente)
const secondaryApp = firebase.initializeApp(firebaseConfig, "Secondary");
const secondaryAuth = secondaryApp.auth();

// --- ATIVAÇÃO DO MODO OFFLINE (CLÁSSICO) ---
// Configura o cache para funcionar sem internet
db.enablePersistence({ synchronizeTabs: true })
    .then(() => {
        console.log("Modo Offline ativado com sucesso!");
    })
    .catch((err) => {
        if (err.code == 'failed-precondition') {
            console.log("Aviso: Múltiplas abas abertas. O modo offline funciona melhor em uma só aba.");
        } else if (err.code == 'unimplemented') {
            console.log("Aviso: Este navegador não suporta salvamento offline.");
        }
    });

// Variáveis Globais
let map, adminMap, osMap; 
let osLayers = L.layerGroup();
let osLabels = L.layerGroup();
let isPreviewMode = false;
let loadedOSFeatures = [];

// Variável global para o Cluster
let farmClusters = null;

// --- LOGIN ---
auth.onAuthStateChanged(async (user) => {
    if (user) {
        const userDoc = await db.collection('users').doc(user.uid).get();
        if (userDoc.exists) {
            const role = userDoc.data().role;
            document.getElementById('login-overlay').classList.add('hidden');
            document.getElementById('main-wrapper').classList.remove('hidden');
            
            if (localStorage.getItem('ds-theme') === 'dark') {
                document.body.classList.add('dark-mode');
                updateThemeIcons(true);
            }

            if (role === 'admin') {
                document.getElementById('admin-interface').classList.remove('hidden');
                loadClientsForAdmin();
                loadClientsForMapFilter();
                loadServiceOrders();
            } else {
                document.getElementById('client-interface').classList.remove('hidden');
                document.getElementById('client-name-display').innerText = userDoc.data().nome.split(' ')[0];
				loadClientProfileStats(user.uid);
                setTimeout(() => { 
				initMap(); 
                if(map) map.invalidateSize();
                loadClientFarms(user.uid); 
                }, 300);
            }
        } else {
            alert("Usuário não encontrado."); auth.signOut();
        }
    } else {
        document.getElementById('login-overlay').classList.remove('hidden');
        document.getElementById('main-wrapper').classList.add('hidden');
    }
});

function login() { const e = document.getElementById('email').value;
const p = document.getElementById('password').value; 
auth.signInWithEmailAndPassword(e, p)
.catch(err => alert("Erro: " + err.message)); }

function logout() { auth.signOut(); location.reload(); }
function toggleTheme() { document.body.classList.toggle('dark-mode'); localStorage.setItem('ds-theme', document.body.classList.contains('dark-mode') ? 'dark' : 'light'); updateThemeIcons(document.body.classList.contains('dark-mode')); }
function updateThemeIcons(isDark) { document.querySelectorAll('.fa-moon, .fa-sun').forEach(icon => { if (isDark) { icon.classList.remove('fa-moon'); icon.classList.add('fa-sun'); } else { icon.classList.remove('fa-sun'); icon.classList.add('fa-moon'); } }); }

// ============================================
// CLIENTE
// ============================================
function initMap() {
    if(map) return;
    
    // 1. Configuração Otimizada do Mapa
    map = L.map('map', {
        zoomControl: false,
        preferCanvas: true,        // Turbo ativado (GPU)
        zoomSnap: 0.5,             // Zoom suave
        zoomDelta: 0.5,
        wheelPxPerZoomLevel: 120,
        minZoom: 4,
        maxZoom: 22
    }).setView([-14.2350, -51.9253], 4);
    
    L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',{
        maxZoom: 20, 
        subdomains:['mt0','mt1','mt2','mt3']
    }).addTo(map);
    
    L.control.zoom({position: 'bottomright'}).addTo(map);

    // 2. INICIALIZA O GRUPO DE CLUSTERS
    // Isso cria a lógica de agrupar as bolinhas
    farmClusters = L.markerClusterGroup({
        // --- AQUI É A REGULAGEM DE DISTÂNCIA ---
        maxClusterRadius: 30,       // Tente 40. (Padrão é 80). Quanto MENOR, mais cedo aparece.
        
        // Outra opção útil: Forçar aparecer tudo num zoom específico
        // disableClusteringAtZoom: 15, // Se descomentar, no zoom 15 tudo se abre na marra
        
        showCoverageOnHover: false,
        zoomToBoundsOnClick: true,
        spiderfyOnMaxZoom: true,
        removeOutsideVisibleBounds: true,
        
        iconCreateFunction: function(cluster) {
            return L.divIcon({ 
                html: '<div style="background-color:rgba(37, 99, 235, 0.9); color:white; width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:bold; border:2px solid white; box-shadow:0 0 5px rgba(0,0,0,0.5);">' + cluster.getChildCount() + '</div>', 
                className: 'my-cluster-icon', 
                iconSize: L.point(30, 30) 
            });
        }
    });
    
    map.addLayer(farmClusters);

    // Botão de GPS
    addLocationControl();
    map.on('locationfound', onLocationFound);
    map.on('locationerror', onLocationError);
}

function loadClientFarms(uid) {
    const list = document.getElementById('farms-list');
    list.innerHTML = "<div style='text-align:center; padding:20px; color:#777'><i class='fa-solid fa-circle-notch fa-spin'></i> Carregando mapas...</div>";
    
    if(farmClusters) farmClusters.clearLayers();
    
    map.eachLayer(layer => {
        if (layer instanceof L.Path && !layer._url) map.removeLayer(layer);
    });

    db.collection('fazendas').where('donoUID', '==', uid).get().then(snap => {
        list.innerHTML = "";
        if(snap.empty) { 
            list.innerHTML = "<div style='padding:20px; text-align:center; color:#777'>Nenhuma fazenda encontrada.</div>"; 
            return; 
        }
        
        const bounds = L.latLngBounds();
        const fragment = document.createDocumentFragment(); 

        // --- MUDANÇA AQUI: CRIAR ARRAY E ORDENAR ---
        let farmsArray = [];
        snap.forEach(doc => farmsArray.push(doc));

        // Ordena do menor para o maior (F01, F02, F03...)
        farmsArray.sort((a, b) => {
            let numA = a.data().numero || 0; // Se não tiver número, considera 0
            let numB = b.data().numero || 0;
            return numA - numB;
        });
        // -------------------------------------------
        
        // Agora fazemos o loop na lista JÁ ORDENADA
        farmsArray.forEach(doc => {
            const f = doc.data();
            const fNum = String(f.numero).padStart(2,'0'); // Garante o 0 na frente (01, 02)
            
            const groupDiv = document.createElement('div');
            groupDiv.className = 'farm-group'; 
            
            const headerDiv = document.createElement('div');
            headerDiv.className = 'farm-header';
            headerDiv.innerHTML = `<span>F${fNum} - ${f.nome}</span><i class="fa-solid fa-chevron-down farm-arrow"></i>`;
            
            const contentDiv = document.createElement('div');
            contentDiv.className = 'farm-content';

            headerDiv.onclick = function() { groupDiv.classList.toggle('open'); };

            const sortedTalhoes = f.talhoes ? f.talhoes.sort((a,b) => a.numero - b.numero) : [];

            sortedTalhoes.forEach(t => {
                try {
                    const geoData = (typeof t.geometry === 'string') ? JSON.parse(t.geometry) : t.geometry;
                    const displayName = t.nomeOriginal || `Talhão ${t.numero}`;
                    const areaM2 = turf.area(geoData);
                    const areaHa = (areaM2 / 10000).toFixed(2); 

                    // 1. Polígono
                    const poly = L.geoJSON(geoData, {
                        smoothFactor: 5.0, 
                        style: {color:'#ffffff', weight:2, fillOpacity:0.1}
                    });

                    bounds.extend(poly.getBounds());

                    // 2. Marcador do Nome
                    const center = turf.centerOfMass(geoData);
                    const latlng = [center.geometry.coordinates[1], center.geometry.coordinates[0]];
                    
                    const labelIcon = L.divIcon({ 
                        className: 'client-plot-label', 
                        html: `<div style="text-align:center; text-shadow: -1px -1px 0 #000, 1px -1px 0 #000; cursor:pointer;">
                                 <b>${displayName}</b><br>
                                 <span style="font-size:0.9em">${areaHa} ha</span>
                               </div>`,
                        iconSize: [100, 40],
                        iconAnchor: [50, 20]
                    });

                    const labelMarker = L.marker(latlng, { icon: labelIcon });

                    labelMarker.on('add', () => { poly.addTo(map); });
                    labelMarker.on('remove', () => { poly.remove(); });

                    farmClusters.addLayer(labelMarker); 

                    // 3. Lista (COM BOTÃO DE MAPA)
                    const row = document.createElement('div');
                    row.className = 'plot-item';
                    
                    row.innerHTML = `
                        <input type="checkbox" class="chk-export" 
                            data-farm-id="${doc.id}" data-farm-name="${f.nome}" data-farm-num="${f.numero}"
                            data-plot-name="${displayName}" data-plot-area="${areaHa}"> 
                        
                        <span>${displayName}</span>
                        
                        <button class="btn-locate-plot" title="Ver no Mapa">
                            <i class="fa-solid fa-location-crosshairs"></i>
                        </button>
                    `;
                    
                    const checkbox = row.querySelector('input');
                    const locateBtn = row.querySelector('.btn-locate-plot');

                    function toggleSelection(forceState) {
                        const newState = (typeof forceState === 'boolean') ? forceState : !checkbox.checked;
                        checkbox.checked = newState;

                        if(newState) {
                            poly.setStyle({color: '#ffcc00', weight: 3, fillOpacity: 0.6});
                            row.classList.add('active');
                        } else {
                            poly.setStyle({color: '#ffffff', weight: 2, fillOpacity: 0.1});
                            row.classList.remove('active');
                        }

                        const total = document.querySelectorAll('.chk-export:checked').length;
                        const fab = document.getElementById('fab-os-mobile');
                        if(fab) {
                             document.getElementById('fab-count').innerText = total;
                             if(total > 0) fab.classList.add('visible'); else fab.classList.remove('visible');
                        }
                    }

                    checkbox.addEventListener('change', () => toggleSelection(checkbox.checked));

                    row.addEventListener('click', (e) => {
                        if(e.target.closest('.btn-locate-plot') || e.target === checkbox) return;
                        toggleSelection(); 
                    });

                    locateBtn.addEventListener('click', (e) => {
                        e.stopPropagation(); 
                        farmClusters.zoomToShowLayer(labelMarker, () => {
                            map.panTo(latlng);
                            poly.openTooltip(); 
                        });
                        switchClientTab('tab-mapa');
                    });

                    poly.on('click', (e) => {
                        L.DomEvent.stopPropagation(e); 
                        toggleSelection(); 
                        groupDiv.classList.add('open');
                        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    });

                    labelMarker.on('click', (e) => {
                        L.DomEvent.stopPropagation(e); 
                        toggleSelection();             
                        groupDiv.classList.add('open'); 
                    });

                    contentDiv.appendChild(row);

                } catch(e){ console.warn("Erro talhão:", e); }
            });

            groupDiv.appendChild(headerDiv);
            groupDiv.appendChild(contentDiv);
            fragment.appendChild(groupDiv);
        });
        
        list.appendChild(fragment);
        if(!snap.empty) setTimeout(() => { map.fitBounds(bounds); }, 500);
    });
}

// Variável temporária para guardar os itens selecionados antes de enviar
let pendingOSItems = [];

// 1. Função chamada pelo botão "Gerar OS" (Apenas abre a janela)
function requestOS() {
    const chks = document.querySelectorAll('.chk-export:checked');
    if(chks.length === 0) return alert("Selecione pelo menos um talhão!");
    
    // Guarda os itens na memória
    pendingOSItems = [];
    chks.forEach(c => {
        const realName = c.getAttribute('data-plot-name');
        pendingOSItems.push({
            farmId: c.getAttribute('data-farm-id'),
            farmName: c.getAttribute('data-farm-name'),
            farmNum: c.getAttribute('data-farm-num'),
            realName: realName,
			area: c.getAttribute('data-plot-area')
        });
    });

    // Atualiza o texto da modal
    document.getElementById('os-summary-text').innerText = `Você selecionou ${pendingOSItems.length} mapas para processamento.`;
    document.getElementById('os-type-input').value = ""; // Limpa o select
    
    // --- LINHA NOVA: Garante que o campo customizado comece escondido ---
    document.getElementById('os-type-custom').style.display = 'none'; 
    document.getElementById('os-type-custom').value = '';
    // -------------------------------------------------------------------
    
    // Abre a modal
    document.getElementById('new-os-modal').classList.remove('hidden');
}

// 2. Função para Fechar a Janela
function closeOSModal() {
    document.getElementById('new-os-modal').classList.add('hidden');
}

function finalizeOS() {
    // --- LÓGICA NOVA PARA PEGAR O TIPO ---
    const selectElement = document.getElementById('os-type-input');
    const customInputElement = document.getElementById('os-type-custom');
    
    let type = selectElement.value;

    // Se escolheu "Outros", pega o valor digitado no campo de texto
    if (type === 'Outros') {
        type = customInputElement.value.trim(); // .trim() remove espaços vazios no começo/fim
    }
    // -------------------------------------
    
    if(!type) {
        alert("Por favor, selecione ou digite o Tipo de Aplicação.");
        return;
    }

    // ... (O resto da função continua igual: const user = firebase...)
    const user = firebase.auth().currentUser;
    const clientName = document.getElementById('client-name-display').innerText;
    const btnSend = document.querySelector('#new-os-modal .btn-success');
    const originalText = "Enviar Pedido"; // Texto original do botão
    
    // Feedback visual imediato
    btnSend.innerText = "Processando...";
    btnSend.disabled = true;

    // Objeto da OS
    const newOrder = {
        clientUid: user.uid,
        clientName: clientName,
        status: 'pendente',
        tipoAplicacao: type,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        items: pendingOSItems,
        offlineCreated: false
    };

    // --- FUNÇÃO AUXILIAR: Tenta enviar com limite de tempo ---
    const tryOnlineSend = () => {
        return new Promise((resolve, reject) => {
            // Define um limite de 3 segundos (3000ms)
            const timeout = setTimeout(() => {
                reject("Timeout: Internet muito lenta ou inexistente");
            }, 3000);

            db.collection('service_orders').add(newOrder)
            .then((docRef) => {
                clearTimeout(timeout); // Cancela o timer se deu certo
                resolve(docRef);
            })
            .catch((err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    };

    // --- LÓGICA DE DECISÃO ---
    // Se o navegador diz que está offline, nem tenta enviar, salva direto.
    if (!navigator.onLine) {
        saveOfflineOrder(newOrder);
        return;
    }

    // Se diz que está online, TENTA enviar, mas com o cronômetro ligado
    tryOnlineSend()
    .then(() => {
        // SUCESSO ONLINE
        alert("Solicitação enviada com sucesso!");
        resetOSForm();
    })
    .catch((error) => {
        // FALHA (Erro ou Timeout) -> Joga pro Offline
        console.warn("Envio online falhou (" + error + "). Salvando offline...");
        
        // Ajusta o objeto para modo offline (precisa de data fixa, não serverTimestamp)
        newOrder.createdAt = new Date(); 
        newOrder.offlineCreated = true;
        
        // Chama a função de salvar localmente
        saveOfflineOrder(newOrder);
    });
}

// Função auxiliar para limpar o formulário
function resetOSForm() {
    document.querySelectorAll('.chk-export:checked').forEach(c => { 
        c.checked = false; 
        c.dispatchEvent(new Event('change')); 
    });
    closeOSModal();
    const btn = document.querySelector('#new-os-modal .btn-success');
    if(btn) { btn.innerText = "Enviar Pedido"; btn.disabled = false; }
}

function toggleMobileSidebar() { 
    document.getElementById('client-sidebar').classList.toggle('open'); 
    document.getElementById('sidebar-overlay-mobile').classList.toggle('show'); 
}

// ============================================
// ADMIN
// ============================================
function showAdminTab(id) {
    document.querySelectorAll('.admin-content > div').forEach(d => d.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
    document.querySelectorAll('.admin-menu-item').forEach(i => i.classList.remove('active'));
    event.currentTarget.classList.add('active'); 
    if(id === 'tab-mapas-admin') setTimeout(() => { if(!adminMap) initAdminMap(); adminMap.invalidateSize(); }, 100);
}

function loadClientsForAdmin() {
    const tbody = document.querySelector('#clients-table tbody'); const select = document.getElementById('farm-client-select');
    tbody.innerHTML = ""; select.innerHTML = '<option value="">Selecione...</option>';
    db.collection('users').where('role', '==', 'client').get().then(snap => {
        snap.forEach(doc => {
            const d = doc.data();
            tbody.innerHTML += `<tr><td>${d.nome}</td><td>${d.email}</td><td style="text-align:center"><button class="btn btn-primary" onclick="viewClientFarms('${doc.id}','${d.nome}')"><i class="fa-solid fa-eye"></i></button> <button class="btn btn-danger" onclick="deleteUser('${doc.id}')"><i class="fa-solid fa-trash"></i></button></td></tr>`;
            let opt = document.createElement('option'); opt.value = doc.id; opt.innerText = d.nome; select.appendChild(opt);
        });
    });
}

async function createClientAccount() {
    const nome = document.getElementById('new-client-name').value;
    const email = document.getElementById('new-client-email').value;
    const pass = document.getElementById('new-client-pass').value;
    if(!nome || !email || !pass) return alert("Preencha tudo.");
    try {
        const cred = await secondaryAuth.createUserWithEmailAndPassword(email, pass);
        await db.collection('users').doc(cred.user.uid).set({nome: nome, email: email, role: 'client', criadoEm: new Date()});
        secondaryAuth.signOut(); alert("Criado!"); loadClientsForAdmin(); loadClientsForMapFilter();
        document.getElementById('new-client-name').value=''; document.getElementById('new-client-email').value=''; document.getElementById('new-client-pass').value='';
    } catch(e) { alert("Erro: "+e.message); }
}

function deleteUser(uid) { if(confirm("Excluir cliente?")) db.collection('users').doc(uid).delete().then(() => { loadClientsForAdmin(); loadClientsForMapFilter(); }); }

async function uploadFarm() {
    const nome = document.getElementById('farm-name').value;
    const numero = document.getElementById('farm-number').value;
    const uid = document.getElementById('farm-client-select').value;
    const file = document.getElementById('kml-file').files[0];
    
    if(!nome || !numero || !uid || !file) {
        showToast("Por favor, preencha todos os campos.", "error");
        return;
    }
    
    const text = await file.text();
    const geojson = toGeoJSON.kml(new DOMParser().parseFromString(text, 'text/xml'));
    const talhoes = [];
    
    geojson.features.forEach((f, i) => {
        if(f.geometry && f.geometry.type.includes('Polygon')) {
            // --- 1. DETETIVE DE NOMES (Procura a coluna certa) ---
            let foundName = null;
            
            // Se o KML foi convertido e tem propriedades
            if (f.properties) {
                // Lista de prioridade: plot_name > talhao > name > label
                const priorityKeys = ['plot_name', 'talhao', 'plot', 'name', 'Name', 'label', 'description'];
                const keys = Object.keys(f.properties);

                for (const keyToFind of priorityKeys) {
                    // Procura a chave ignorando maiúsculas/minúsculas (ex: Plot_Name ou plot_name)
                    const realKey = keys.find(k => k.toLowerCase() === keyToFind.toLowerCase());
                    if (realKey && f.properties[realKey]) {
                        foundName = f.properties[realKey];
                        break; // Achou! Para de procurar.
                    }
                }
            }
            
            // Se não achou nada, usa um genérico
            let raw = foundName || `Talhão ${i+1}`;
            
            // --- 2. CORREÇÃO DO NÚMERO (Evita pegar o número da fazenda) ---
            let tNum = i + 1; // Padrão: Sequencial (1, 2, 3...)
            
            if(raw) {
                const rawStr = raw.toString();
                
                // Estratégia A: Procura explícito por "T01", "Talhão 10"
                const matchExplicit = rawStr.match(/(?:T|Talhao|Talhão)[\s_-]*(\d+)/i);
                
                if (matchExplicit) {
                    tNum = parseInt(matchExplicit[1]);
                } else {
                    // Estratégia B: Se não tem "T", pega todos os números da string
                    const numbers = rawStr.match(/(\d+)/g);
                    
                    if (numbers) {
                        // O TRUQUE: Pega o ÚLTIMO número encontrado.
                        // Ex: "Fazenda 55 Talhão 02" -> O array é ["55", "02"]. Pegamos o "02".
                        tNum = parseInt(numbers[numbers.length - 1]);
                    }
                }
            }
            
            talhoes.push({ 
                numero: tNum, 
                nomeOriginal: raw, 
                geometry: JSON.stringify(f.geometry) 
            });
        }
    });
    
    if(talhoes.length === 0) {
        showToast("O arquivo KML não contém polígonos válidos.", "error");
        return;
    }

    db.collection('fazendas').add({ 
        nome: nome, 
        numero: parseInt(numero), 
        donoUID: uid, 
        talhoes: talhoes, 
        criadoEm: new Date() 
    }).then(() => {
        showToast("Fazenda cadastrada com sucesso!", "success");
        
        // Limpa os campos
        document.getElementById('farm-name').value = '';
        document.getElementById('farm-number').value = '';
        document.getElementById('kml-file').value = '';
        document.getElementById('file-name-display').innerText = '';
        
        // Atualiza a lista no mapa
        const currentFilter = document.getElementById('map-admin-client-select').value;
        if(currentFilter === uid) {
            loadAdminFarmsList(uid);
        }
    }).catch(e => {
        showToast("Erro ao salvar: " + e.message, "error");
    });
}

function updateFileName(input) {
    if (input.files && input.files[0]) {
        const fileName = input.files[0].name;

        // 1. Mostra o nome do arquivo na tela (feedback visual)
        document.getElementById('file-name-display').innerText = fileName;

        // --- LÓGICA DE PREENCHIMENTO AUTOMÁTICO ---

        // A. Tenta achar o NÚMERO
        // Procura pelo primeiro grupo de números no nome do arquivo
        const numMatch = fileName.match(/(\d+)/);
        if (numMatch) {
            // Se achou, converte para número inteiro (tira zeros à esquerda, ex: 05 vira 5)
            document.getElementById('farm-number').value = parseInt(numMatch[0]);
        }

        // B. Tenta limpar o NOME
        // 1. Remove a extensão ".kml" (maiúscula ou minúscula)
        let cleanName = fileName.replace(/\.kml$/i, '');

        // 2. Remove o número e prefixos comuns do início (ex: "F05 - ", "05 ", "Fazenda 10 -")
        // Explicação da RegEx: Começo da linha (^), opcionalmente 'F' ou 'Fazenda', seguido de números, seguido de traço ou espaço
        cleanName = cleanName.replace(/^(F|Fazenda)?\s*\d+\s*[-_]?\s*/i, '');

        // 3. Preenche o campo
        document.getElementById('farm-name').value = cleanName.trim();
    }
}

function initAdminMap() { 
    if(adminMap) return; 
    
    adminMap = L.map('admin-map', {
        zoomControl: true,
        preferCanvas: true // <--- ISSO É O SEGREDO! Usa a GPU do celular.
    }).setView([-14,-52],4); 
    
    L.tileLayer('https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',{
        maxZoom:20,
        subdomains:['mt0','mt1','mt2','mt3']
    }).addTo(adminMap); 

    // Lógica de Zoom Inteligente
    adminMap.on('zoomend', function() {
        const zoom = adminMap.getZoom();
        const mapDiv = document.getElementById('admin-map');
        if (zoom < 13) {
            mapDiv.classList.add('hide-labels');
        } else {
            mapDiv.classList.remove('hide-labels');
        }
    });
}

function loadClientsForMapFilter() {
    const s = document.getElementById('map-admin-client-select'); if(!s) return; s.innerHTML='<option value="">Selecione...</option>';
    db.collection('users').where('role','==','client').get().then(snap => snap.forEach(d => { let o=document.createElement('option'); o.value=d.id; o.innerText=d.data().nome; s.appendChild(o); }));
}

function loadAdminFarmsList(uid) {
    const s = document.getElementById('map-admin-farm-select'); 
    s.innerHTML = '<option>Carregando...</option>'; 
    s.disabled = true;
    
    // Limpa o mapa se mudar de cliente
    if(adminMap) adminMap.eachLayer(l=>{if(!l._url) adminMap.removeLayer(l)});
    
    if(!uid) { 
        s.innerHTML = '<option>Aguardando...</option>'; 
        return; 
    }
    
    db.collection('fazendas').where('donoUID','==',uid).get().then(snap => {
        s.innerHTML = '<option value="">Selecione a Fazenda...</option>'; 
        s.disabled = false;
        
        // 1. Converte os dados para uma lista (Array) para podermos ordenar
        let farms = [];
        snap.forEach(doc => {
            farms.push({ id: doc.id, ...doc.data() });
        });

        // 2. Ordena a lista pelo NÚMERO da fazenda (Crescente: 1, 2, 3...)
        farms.sort((a, b) => a.numero - b.numero);

        // 3. Cria as opções na tela
        farms.forEach(f => { 
            let o = document.createElement('option'); 
            o.value = f.id;
            
            // 4. Formatação: Adiciona o ZERO à esquerda (Ex: 1 vira 01, 10 continua 10)
            const fNum = String(f.numero).padStart(2, '0');
            
            o.innerText = `F${fNum} - ${f.nome}`; 
            s.appendChild(o); 
        });
    });
}

function loadAdminMap(fid) {
    const colorControl = document.getElementById('farm-color-control');
    
    // 1. Controle de exibição (Segurança extra)
    if(!fid) {
        if(colorControl) colorControl.style.display = 'none';
        return;
    }
    
    // FORÇA O CONTROLE A APARECER
    if(colorControl) {
        colorControl.classList.remove('hidden'); // Remove a classe se ela existir
        colorControl.style.display = 'flex';     // Força o display flex
    }

    const farmColors = [
        '#e74c3c', '#8e44ad', '#3498db', '#1abc9c', '#f1c40f', 
        '#e67e22', '#2ecc71', '#d35400', '#2980b9', '#c0392b',
        '#9b59b6', '#16a085', '#f39c12', '#27ae60', '#7f8c8d', 
        '#2c3e50', '#e84393', '#00cec9', '#6c5ce7', '#fdcb6e', 
        '#d63031', '#0984e3', '#00b894', '#ffeaa7', '#ff7675'
    ];

    db.collection('fazendas').doc(fid).get().then(doc => {
        if (!doc.exists) return;

        const f = doc.data(); 
        const b = L.latLngBounds();
        
        if(adminMap) adminMap.eachLayer(l => { if(!l._url) adminMap.removeLayer(l) });
        
        // Lógica da Cor
        const colorIndex = f.numero ? f.numero : 0;
        const autoColor = farmColors[colorIndex % farmColors.length];
        const finalColor = f.cor ? f.cor : autoColor; 

        // Atualiza a bolinha
        const picker = document.getElementById('farm-color-picker');
        if(picker) picker.value = finalColor;
        
        if(typeof updateColorPreview === 'function') updateColorPreview(finalColor);

        f.talhoes.forEach(t => { 
            try {
                const geoData = JSON.parse(t.geometry);
                const displayName = t.nomeOriginal || `Talhão ${t.numero}`;
                const areaM2 = turf.area(geoData);
                const areaHa = (areaM2 / 10000).toFixed(2);

                const p = L.geoJSON(geoData, {
                    style: { color: '#000000', weight: 1, fillColor: finalColor, fillOpacity: 0.8 }
                }).addTo(adminMap);
                
                const center = turf.centerOfMass(geoData);
                const labelHtml = `<div><span style="font-size:12px">${displayName}</span><br><span style="font-size:10px">${areaHa} ha</span></div>`;
                const labelIcon = L.divIcon({ className: 'admin-map-label', html: labelHtml, iconSize: [0,0] });
                L.marker([center.geometry.coordinates[1], center.geometry.coordinates[0]], {icon: labelIcon}).addTo(adminMap);
                
                p.bindTooltip(`<strong>${displayName}</strong> (${areaHa} ha)`, { direction: 'top' }); 
                b.extend(p.getBounds());
            } catch(e){} 
        });
        
        if(f.talhoes.length) adminMap.fitBounds(b);
    });
}

function loadAllFarmsOnMap() {
    if(!adminMap) initAdminMap(); 
    
    // Esconde o controle de cor pois estamos vendo todas
    const colorControl = document.getElementById('farm-color-control');
    if(colorControl) colorControl.style.display = 'none';

    adminMap.eachLayer(l => { if(!l._url) adminMap.removeLayer(l) });
    document.getElementById('map-admin-client-select').value = ""; 
    document.getElementById('map-admin-farm-select').disabled = true;

    const farmColors = [
        '#e74c3c', '#8e44ad', '#3498db', '#1abc9c', '#f1c40f', 
        '#e67e22', '#2ecc71', '#d35400', '#2980b9', '#c0392b'
    ];

    db.collection('fazendas').get().then(snap => {
        const b = L.latLngBounds(); 
        let c = 0;

        snap.forEach(doc => {
            const f = doc.data();
            
            // --- MESMA LÓGICA DE COR AQUI ---
            const colorIndex = f.numero ? f.numero : 0;
            const autoColor = farmColors[colorIndex % farmColors.length];
            const finalColor = f.cor ? f.cor : autoColor; // Prioriza a cor salva
            
            f.talhoes.forEach(t => { 
                try {
                    const geoData = JSON.parse(t.geometry);
                    const displayName = t.nomeOriginal || `Talhão ${t.numero}`;
                    const areaM2 = turf.area(geoData);
                    const areaHa = (areaM2 / 10000).toFixed(2);

                    const p = L.geoJSON(geoData, {
                        style: { color: '#000000', weight: 1, fillColor: finalColor, fillOpacity: 0.7 } 
                    }).addTo(adminMap);
                    
                    const center = turf.centerOfMass(geoData);
                    const labelHtml = `
                        <div>
                            <span style="font-size:11px">${displayName}</span><br>
                            <span style="font-size:9px">${areaHa} ha</span>
                        </div>
                    `;
                    
                    const labelIcon = L.divIcon({ className: 'admin-map-label', html: labelHtml, iconSize:[0,0] });
                    L.marker([center.geometry.coordinates[1], center.geometry.coordinates[0]], {icon:labelIcon}).addTo(adminMap);
                    
                    b.extend(p.getBounds()); 
                    c++;
                } catch(e){} 
            });
        });

        if(c > 0) adminMap.fitBounds(b);
    });
}

function viewClientFarms(uid, name) {
    document.getElementById('admin-modal').classList.remove('hidden'); document.getElementById('modal-client-name').innerText = `Fazendas de ${name}`;
    const c = document.getElementById('modal-content'); c.innerHTML='Carregando...';
    db.collection('fazendas').where('donoUID','==',uid).get().then(snap => {
        c.innerHTML = snap.empty ? 'Nenhuma fazenda.' : '';
        snap.forEach(doc => { const f = doc.data(); c.innerHTML += `<div class="admin-farm-item"><div><strong>F${f.numero} - ${f.nome}</strong><small>${f.talhoes.length} talhões</small></div><button class="btn btn-danger" onclick="deleteFarm('${doc.id}','${uid}','${name}')"><i class="fa-solid fa-trash"></i></button></div>`; });
    });
}
function deleteFarm(fid, uid, name) { if(confirm("Apagar fazenda?")) db.collection('fazendas').doc(fid).delete().then(() => viewClientFarms(uid, name)); }
function closeModal() { document.getElementById('admin-modal').classList.add('hidden'); }

// ============================================
// EDITOR DE OS
// ============================================
    function loadServiceOrders() {
    const tbody = document.querySelector('#os-table tbody');
    
    db.collection('service_orders').orderBy('createdAt','desc').onSnapshot(snap => {
        tbody.innerHTML = ""; 
        let p=0;
        
        snap.forEach(doc => {
            const os = doc.data();
            if(os.status === 'pendente') p++;
            
            // Cores do Status
            let sClass = 'color:#e67e22'; // Laranja
            if(os.status === 'em analise') sClass = 'color:#2980b9'; // Azul
            if(os.status === 'concluido') sClass = 'color:#27ae60'; // Verde
            if(os.status === 'cancelado') sClass = 'color:#c0392b'; // Vermelho

            const tipoApp = os.tipoAplicacao ? os.tipoAplicacao : '-';

            // --- LÓGICA DOS BOTÕES DE AÇÃO ---
            let buttonsHtml = `<button class="btn btn-primary" style="margin-right:5px; padding:6px 10px;" onclick="openOSEditor('${doc.id}')" title="Abrir Editor"><i class="fa-solid fa-map"></i></button>`;
            
            // Só mostra o botão de concluir se ela NÃO estiver concluída nem cancelada
            if(os.status !== 'concluido' && os.status !== 'cancelado') {
                buttonsHtml += `<button class="btn btn-success" style="padding:6px 10px;" onclick="finishOS('${doc.id}')" title="Marcar como Concluída"><i class="fa-solid fa-check"></i></button>`;
            }
            // ---------------------------------

            tbody.innerHTML += `
                <tr>
                    <td>${new Date(os.createdAt.seconds*1000).toLocaleDateString()}</td>
                    <td>${os.clientName}</td>
                    <td>${os.items.length} itens</td>
                    <td><strong>${tipoApp}</strong></td>
                    <td style="font-weight:bold;${sClass}">${os.status.toUpperCase()}</td>
                    <td>${buttonsHtml}</td>
                </tr>`;
        });
        
        const badge = document.getElementById('badge-os'); 
        if(p>0) { badge.style.display='inline-block'; badge.innerText=p; } 
        else badge.style.display='none';
    });
}

    async function openOSEditor(osId) {
    document.getElementById('os-editor-overlay').classList.remove('hidden');

    if (!osMap) {
        osMap = L.map('os-map', {
            zoomControl: false,
            zoomSnap: 0.05,
            zoomDelta: 0.05,
            wheelPxPerZoomLevel: 500
        }).setView([-14, -52], 5);
        
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { 
            maxZoom: 19, attribution: '&copy; OSM contributors' 
        }).addTo(osMap);
        
        osLayers.addTo(osMap);
        osLabels.addTo(osMap);

        const scale = L.control.scale({ position: 'bottomleft', metric: true, imperial: false, maxWidth: 200 });
        scale._updateMetric = function (maxMeters) {
            const meters = this._getRoundNum(maxMeters);
            const label = meters + ' m';
            this._updateScale(this._mScale, label, meters / maxMeters);
        };
        scale.addTo(osMap);
        document.getElementById('os-scale-container').appendChild(scale.getContainer());
    }
    
    const doc = await db.collection('service_orders').doc(osId).get();
    if(!doc.exists) return;
    const osData = doc.data();
    if(osData.status === 'pendente') db.collection('service_orders').doc(osId).update({status: 'em analise'});

    osLayers.clearLayers(); osLabels.clearLayers();
    document.getElementById('os-legend-content').innerHTML = "";
    
    // Configura Título e Logo
    const nomeCliente = osData.clientName ? osData.clientName.toUpperCase() : "CLIENTE";
    const tipoAplicacao = osData.tipoAplicacao ? osData.tipoAplicacao.toUpperCase() : "SERVIÇO";
    const tituloPadrao = `${nomeCliente} - MAPA ESTRATÉGICO - ${tipoAplicacao}`;
    document.getElementById('cfg-title-text').value = tituloPadrao;
    updateOSTitle();
    
    const urlSuaLogo = "imagem/logo.png"; 
    const imgLogo = document.getElementById('os-map-logo');
    if(imgLogo) {
        imgLogo.src = urlSuaLogo;
        imgLogo.onerror = function() { this.style.display = 'none'; };
        imgLogo.onload = function() { this.style.display = 'block'; };
        document.getElementById('cfg-logo-file').value = ""; 
    }

    loadedOSFeatures = []; 
    const bounds = L.latLngBounds(); let totalHectares = 0;
    const farmGroups = {};
    
    osData.items.forEach(i => { 
        if(!farmGroups[i.farmId]) farmGroups[i.farmId] = [];
        farmGroups[i.farmId].push(i.realName); 
    });

    const colors = ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6'];
    let colorIndex = 0;

    for (const [farmId, targetNames] of Object.entries(farmGroups)) {
        const farmDoc = await db.collection('fazendas').doc(farmId).get();
        if(farmDoc.exists) {
            const f = farmDoc.data();
            const color = colors[colorIndex % colors.length];
            let farmHectares = 0;

            // Ordena os talhões para garantir organização visual
            if(f.talhoes) {
                f.talhoes.sort((a, b) => {
                    const getNum = (str) => {
                        const match = (str || "").toString().match(/(\d+)/g);
                        return match ? parseInt(match[match.length-1]) : 9999;
                    };
                    return getNum(a.nomeOriginal) - getNum(b.nomeOriginal);
                });
            }

            f.talhoes.forEach((t, index) => {
                const dbName = t.nomeOriginal || `Talhão ${t.numero}`;
                
                if(targetNames.includes(dbName)) {
                    try {
                        const geoData = JSON.parse(t.geometry);
                        const area = turf.area(geoData) / 10000;
                        
                        // --- AQUI ESTÁ A CORREÇÃO ---
                        // 1. Prioridade total para o nome original do talhão (MUCUIN, F02 T25, etc)
                        let labelTitle = t.nomeOriginal;
                        
                        // 2. Só cria um nome automático se o original estiver vazio
                        if(!labelTitle || labelTitle.trim() === "") {
                            const fNum = String(f.numero).padStart(2,'0'); 
                            const tNum = String(index + 1).padStart(2,'0');
                            labelTitle = `F${fNum} T${tNum}`;
                        }

                        loadedOSFeatures.push({
                            type: 'Feature',
                            properties: {
                                farmName: f.nome,
                                farmNumber: f.numero,
                                plotName: labelTitle, // Usa o nome real
                                plotNumber: t.numero,
                                areaHa: area.toFixed(2),
                                color: color
                            },
                            geometry: geoData
                        });

                        const poly = L.geoJSON(geoData, {
                            style: { color: 'black', weight: 1, fillColor: color, fillOpacity: 1 }
                        });
                        
                        farmHectares += area;
                        totalHectares += area;

                        poly.addTo(osLayers);
                        bounds.extend(poly.getBounds());

                        const center = turf.centerOfMass(geoData);
                        const labelHtml = `<div style="text-align:center; text-shadow: -1px -1px 0 #fff, 1px -1px 0 #fff; line-height:1.2;">
                            <b style="font-size:12px; white-space:nowrap;">${labelTitle}</b><br>
                            <span style="font-size:10px; white-space:nowrap;">${area.toFixed(2)} ha</span>
                        </div>`;
                        
                        const labelIcon = L.divIcon({ className: 'os-label', html: labelHtml, iconSize:[0,0] });
                        L.marker([center.geometry.coordinates[1], center.geometry.coordinates[0]], {icon:labelIcon}).addTo(osLabels);

                    } catch(e){}
                }
            });

            document.getElementById('os-legend-content').innerHTML += `<div class="legend-item"><div class="legend-color-box" style="background:${color}"></div><span>F${f.numero} - ${f.nome} (${farmHectares.toFixed(2)} ha)</span></div>`;
            colorIndex++;
        }
    }

    document.getElementById('os-legend-content').innerHTML += `
        <div class="legend-total">
            TOTAL GERAL: ${totalHectares.toFixed(2)} ha
        </div>`;

    if(totalHectares > 0) osMap.fitBounds(bounds);
    updateOSMapStyles();
}

function closeOSEditor() { document.getElementById('os-editor-overlay').classList.add('hidden'); if(isPreviewMode) toggleOSPreviewMode(); }
function updateOSTitle() { document.getElementById('os-map-title').innerText = document.getElementById('cfg-title-text').value; }
function updateOSLogo() { const i = document.getElementById('cfg-logo-file'); const img = document.getElementById('os-map-logo'); if(i.files[0]) { const r = new FileReader(); r.onload=e=>img.src=e.target.result; r.readAsDataURL(i.files[0]); } }
   
    function updateOSMapStyles() {
    const sc = document.getElementById('cfg-stroke-color').value; 
    const sw = document.getElementById('cfg-stroke-width').value;
    const fs = document.getElementById('cfg-font-size').value; // Valor do input
    const fc = document.getElementById('cfg-font-color').value;
    
    // Configurações de Texto
    const flh = document.getElementById('cfg-font-line-height').value;
    const fse = document.getElementById('cfg-font-stroke-enable').checked; 
    const fsc = document.getElementById('cfg-font-stroke-color').value;
    const fsw = document.getElementById('cfg-font-stroke-width').value;
    
    // Atualiza as linhas dos polígonos
    osLayers.eachLayer(l => {
        if(l.setStyle) l.setStyle({color: sc, weight: parseFloat(sw)})
    });
    
    // Atualiza os textos (Labels)
    document.querySelectorAll('.os-label div').forEach(e => {
        e.style.color = fc; 
        
        if (fse) {
            e.style.webkitTextStroke = `${fsw}px ${fsc}`;
            e.style.paintOrder = "stroke fill";
            e.style.textShadow = 'none'; 
        } else {
            e.style.webkitTextStroke = '0px transparent';
            e.style.textShadow = 'none';
        }
        
        e.style.lineHeight = flh; 
        
        // 1. Aplica o tamanho no NOME (Tag <b>)
        const nameEl = e.querySelector('b');
        if(nameEl) nameEl.style.fontSize = fs + 'px';

        // 2. Aplica o tamanho na ÁREA (Tag <span>)
        const areaEl = e.querySelector('span');
        if(areaEl) {
            // AGORA SIM: Usa o mesmo valor 'fs' do nome, sem diminuir nada.
            areaEl.style.fontSize = fs + 'px';
        }
    });

    // Configurações da Legenda
    const ls = document.getElementById('cfg-legend-size').value; 
    const lbs = document.getElementById('cfg-legend-box-size').value;
    const lsp = document.getElementById('cfg-legend-spacing').value;
    const lst = document.getElementById('cfg-legend-stroke').value;
    
    document.querySelectorAll('.legend-item').forEach(i => i.style.marginBottom = lsp + 'px');
    document.querySelectorAll('.legend-item span').forEach(s => {
        s.style.fontSize = ls + 'px';
        if(lst > 0) s.style.textShadow = `-0.5px -0.5px 0 #fff, 0.5px -0.5px 0 #fff`; 
    });
    document.querySelectorAll('.legend-color-box').forEach(b => {
        b.style.width = lbs + 'px';
        b.style.height = lbs + 'px';
    });
}

function toggleOSPreviewMode() {
    isPreviewMode=!isPreviewMode;
    if(isPreviewMode) { document.body.classList.add('preview-active'); osMap.invalidateSize(); const b=L.latLngBounds([]); osLayers.eachLayer(l=>{if(l.getBounds) b.extend(l.getBounds())}); if(b.isValid()) osMap.fitBounds(b); }
    else { document.body.classList.remove('preview-active'); osMap.invalidateSize(); }
}

function printOS() {
    // 1. Adiciona a etiqueta
    document.body.classList.add('printing-map');

    // 2. Força o modo preview (tela cheia)
    if(!isPreviewMode) {
        toggleOSPreviewMode();
    }
    
    // 3. O SEGREDO: Força o Leaflet a recalcular o tamanho do mapa
    // Isso evita o bug da tela branca ou cinza
    if(osMap) osMap.invalidateSize();

    // 4. Delay um pouco maior para garantir que o mapa carregou os tiles
    setTimeout(() => {
        window.print();

        // 5. Remove a etiqueta depois de imprimir
        document.body.classList.remove('printing-map');
    }, 800); // Aumentei para 800ms para dar tempo do navegador processar
}

function toggleConfigBody() {
    const body = document.getElementById('config-body');
    const panel = document.getElementById('config-panel');
    
    if (body.style.display === 'none') {
        body.style.display = 'block';
        // panel.style.height = 'auto'; // Removido para manter 100% de altura
        panel.style.width = '260px'; // Largura aberta
    } else {
        body.style.display = 'none';
        // panel.style.height = 'auto'; // Removido para manter 100% de altura
        panel.style.width = '180px'; // Largura fechada (ajuste conforme seu gosto)
    }

    // Mágica para o Leaflet recalcular o tamanho do mapa imediatamente
    setTimeout(() => {
        if(osMap) osMap.invalidateSize();
    }, 200);
}

// Variável Global para armazenar os pedidos carregados
let loadedClientOrders = []; 

// 1. ATUALIZE ESTA FUNÇÃO (openClientHistory)
function openClientHistory() {
    const modal = document.getElementById('client-history-modal');
    const content = document.getElementById('client-history-content');
    const user = firebase.auth().currentUser;

    if (!user) return;

    modal.classList.remove('hidden');
    content.innerHTML = "<div style='text-align:center; padding:30px; color:#777'><i class='fa-solid fa-circle-notch fa-spin'></i> Buscando histórico...</div>";

    db.collection('service_orders').where('clientUid', '==', user.uid).get().then(snap => {
        if (snap.empty) {
            content.innerHTML = "<div style='text-align:center; padding:30px;'>Você ainda não fez nenhuma solicitação.</div>";
            return;
        }

        loadedClientOrders = []; // Limpa a lista global
        snap.forEach(doc => {
            loadedClientOrders.push({ id: doc.id, ...doc.data() });
        });
        
        // Ordena
        loadedClientOrders.sort((a, b) => b.createdAt.seconds - a.createdAt.seconds);

        let html = "";
        loadedClientOrders.forEach(os => {
            const date = new Date(os.createdAt.seconds * 1000).toLocaleDateString('pt-BR');
            let statusClass = 'status-pendente'; let statusLabel = os.status;
            
            if(os.status === 'em analise') { statusClass = 'status-analise'; statusLabel = 'Em Análise'; }
            if(os.status === 'concluido') { statusClass = 'status-concluido'; statusLabel = 'Concluído'; }
            if(os.status === 'cancelado') { statusClass = 'status-cancelado'; statusLabel = 'Cancelado'; }

            // Adicionei onclick="openOrderDetails(...)" na div inteira para ficar clicável
            html += `
                <div class="history-item" onclick="openOrderDetails('${os.id}')" style="cursor:pointer;" title="Clique para ver detalhes">
                    <div class="history-info">
                        <strong><i class="fa-regular fa-calendar"></i> ${date}</strong>
                        <small>${os.items.length} mapa(s) - ${os.tipoAplicacao || 'Serviço'}</small>
                    </div>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <span class="status-badge ${statusClass}">${statusLabel}</span>
                        <i class="fa-solid fa-chevron-right" style="color:#cbd5e1;"></i>
                    </div>
                </div>
            `;
        });

        content.innerHTML = html;
    }).catch(err => {
        console.error(err);
        content.innerHTML = "<div style='text-align:center; padding:20px; color:red'>Erro ao carregar histórico.</div>";
    });
}

// 2. ADICIONE ESTAS DUAS NOVAS FUNÇÕES

function openOrderDetails(orderId) {
    // Encontra o pedido na memória
    const order = loadedClientOrders.find(o => o.id === orderId);
    if(!order) return;

    // --- 1. PREPARAÇÃO DOS DADOS (Cálculos) ---
    let totalArea = 0;
    const uniqueFarms = new Set();
    let itemsHtml = "";

    order.items.forEach(item => {
        const fName = item.farmName || "-";
        const fNum = item.farmNum ? String(item.farmNum).padStart(2,'0') : "00";
        const tName = item.realName || "Talhão Sem Nome";
        
        if(item.farmName) uniqueFarms.add(item.farmName);

        let areaDisplay = "";
        if (item.area && item.area !== "undefined" && item.area !== null) {
            const val = parseFloat(item.area);
            if(!isNaN(val)) totalArea += val;
            areaDisplay = `<strong style="margin-left:5px;">(${item.area} ha)</strong>`;
        }

        itemsHtml += `
            <tr>
                <td>${fName}</td>
                <td>F${fNum}</td>
                <td>${tName} ${areaDisplay}</td>
            </tr>
        `;
    });

    // --- 2. ATUALIZA A DATA E TABELA (Estes ficam fora da caixa problemática) ---
    const dateEl = document.getElementById('detail-date');
    if(dateEl) dateEl.innerText = "Data: " + new Date(order.createdAt.seconds * 1000).toLocaleDateString('pt-BR');
    
    const tableEl = document.getElementById('detail-items-list');
    if(tableEl) tableEl.innerHTML = itemsHtml;

    // --- 3. RECONSTRÓI A CAIXA DE INFORMAÇÕES (Correção do Erro NULL) ---
    // Aqui nós recriamos o HTML inteiro, GARANTINDO que os IDs existam para a impressão funcionar
    
    // Define a cor do status
    let statusColor = '#333';
    if(order.status === 'concluido') statusColor = 'green';
    if(order.status === 'cancelado') statusColor = 'red';

    const infoBox = document.querySelector('.report-info-box');
    
    if(infoBox) {
        infoBox.innerHTML = `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                <div>
                    <p><strong>Cliente:</strong> <span id="detail-client">${order.clientName}</span></p>
                    <p><strong>Tipo:</strong> <span id="detail-type" class="highlight-type">${order.tipoAplicacao || '-'}</span></p>
                    <p><strong>Status:</strong> <span id="detail-status" style="color:${statusColor}">${order.status.toUpperCase()}</span></p>
                </div>
                <div style="border-left: 2px solid #ddd; padding-left: 15px; display: flex; flex-direction: column; justify-content: center;">
                    <h4 style="margin: 0 0 5px 0; color: #0f172a;">RESUMO GERAL</h4>
                    <p style="margin: 2px 0;"><strong>Fazendas:</strong> ${uniqueFarms.size}</p>
                    <p style="margin: 2px 0;"><strong>Talhões:</strong> ${order.items.length}</p>
                    <p style="margin: 2px 0; font-size: 1.1em; color: var(--primary);"><strong>Total Área:</strong> ${totalArea.toFixed(2)} ha</p>
                </div>
            </div>
        `;
    }

    // Abre a modal
    const modal = document.getElementById('order-details-modal');
    if(modal) modal.classList.remove('hidden');
}

// Fecha o modal do relatório e destrava a tela
function closeOrderDetails() {
    const modal = document.getElementById('order-details-modal');
    modal.classList.add('hidden'); // Esconde o modal
    
    // Garante que o scroll da página volte a funcionar
    document.body.style.overflow = 'auto'; 
}

function printOrderReport() {
    // 1. Muda o título da página temporariamente
    const originalTitle = document.title;
    
    try {
        const clientName = document.getElementById('detail-client').innerText;
        const date = document.getElementById('detail-date').innerText.split(': ')[1].replace(/\//g, '-');
        document.title = `Pedido_${clientName}_${date}`;
    } catch (e) {
        document.title = "Relatorio_Solicitacao";
    }

    // --- MUDANÇA AQUI: Adiciona a classe específica para Relatório ---
    document.body.classList.add('printing-report');

    // 2. Chama a impressão
    window.print();

    // 3. Remove a classe e devolve o título original
    // O timeout garante que o navegador tenha tempo de processar os estilos antes de remover
    setTimeout(() => {
        document.body.classList.remove('printing-report');
        document.title = originalTitle;
    }, 500);
}


function saveProjectJSON() {
    // 1. Captura os dados atuais dos inputs
    const projectData = {
        meta: {
            version: "1.0",
            savedAt: new Date().toISOString(),
            system: "DS Portal"
        },
        project: {
            title: document.getElementById('cfg-title-text').value,
            client: document.getElementById('client-name-display') ? document.getElementById('client-name-display').innerText : "Cliente"
        },
        styles: {
            strokeColor: document.getElementById('cfg-stroke-color').value,
            strokeWidth: document.getElementById('cfg-stroke-width').value,
            fontSize: document.getElementById('cfg-font-size').value,
            fontColor: document.getElementById('cfg-font-color').value,
            fontLineHeight: document.getElementById('cfg-font-line-height').value,
            fontStrokeEnable: document.getElementById('cfg-font-stroke-enable').checked,
            fontStrokeColor: document.getElementById('cfg-font-stroke-color').value,
            fontStrokeWidth: document.getElementById('cfg-font-stroke-width').value
        },
        legend: {
            size: document.getElementById('cfg-legend-size').value,
            spacing: document.getElementById('cfg-legend-spacing').value,
            boxSize: document.getElementById('cfg-legend-box-size').value,
            stroke: document.getElementById('cfg-legend-stroke').value
        },
        // --- AQUI ESTÁ O PULO DO GATO: SALVAMOS OS DADOS DO MAPA ---
        data: loadedOSFeatures
    };

    // 2. Cria o arquivo para download
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(projectData, null, 2));
    const downloadAnchorNode = document.createElement('a');
    
    // Nome do arquivo limpo e organizado
    const cleanTitle = projectData.project.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const fileName = `projeto_${cleanTitle}_${new Date().toISOString().slice(0,10)}.json`;
    
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", fileName);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
}


// Função global para mostrar mensagens bonitas
function showToast(message, type = 'success') {
    // 1. Cria o elemento
    const toast = document.createElement('div');
    toast.className = `toast-notification ${type}`;
    
    // 2. Define ícone baseado no tipo
    let icon = '<i class="fa-solid fa-check-circle"></i>';
    if(type === 'error') icon = '<i class="fa-solid fa-triangle-exclamation"></i>';
    if(type === 'info')  icon = '<i class="fa-solid fa-circle-info"></i>';

    toast.innerHTML = `${icon} <span>${message}</span>`;
    
    // 3. Adiciona na tela
    document.body.appendChild(toast);

    // 4. Animação de entrada (pequeno delay para o CSS processar)
    setTimeout(() => toast.classList.add('show'), 100);

    // 5. Remove depois de 4 segundos
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300); // Espera a animação de saída
    }, 4000);
}


// Função de Pesquisa do Cliente
function filterClientList() {
    const term = document.getElementById('client-search-input').value.toLowerCase();
    const groups = document.querySelectorAll('.farm-group');

    groups.forEach(group => {
        // Pega o nome da Fazenda (F01 - Nome)
        const farmName = group.querySelector('.farm-header span').innerText.toLowerCase();
        
        // Pega todos os talhões dessa fazenda
        const items = group.querySelectorAll('.plot-item');
        let hasMatchInPlots = false;

        // 1. Verifica se a FAZENDA combina com a pesquisa
        if (farmName.includes(term)) {
            group.style.display = "block"; // Mostra o grupo
            items.forEach(item => item.style.display = "flex"); // Mostra todos os itens
            // Se a pesquisa estiver vazia, fecha o acordeão (opcional)
            if(term === "") group.classList.remove('open');
            return; // Sai daqui, já achou a fazenda inteira
        }

        // 2. Se a fazenda não combinou, verifica os TALHÕES um por um
        items.forEach(item => {
            const plotName = item.querySelector('span').innerText.toLowerCase();
            
            if (plotName.includes(term)) {
                item.style.display = "flex"; // Mostra esse talhão
                hasMatchInPlots = true;
            } else {
                item.style.display = "none"; // Esconde os outros
            }
        });

        // 3. Decide se mostra ou esconde o GRUPO da Fazenda
        if (hasMatchInPlots) {
            group.style.display = "block";
            group.classList.add('open'); // ABRE A FAZENDA AUTOMATICAMENTE
        } else {
            group.style.display = "none"; // Esconde a fazenda inteira se nada combinar
        }
    });
}


// Função para Concluir a OS
function finishOS(osId) {
    if(!confirm("Deseja marcar esta solicitação como CONCLUÍDA?")) return;

    // Atualiza o status no banco de dados
    db.collection('service_orders').doc(osId).update({
        status: 'concluido',
        dataConclusao: new Date()
    }).then(() => {
        showToast("Solicitação concluída com sucesso!", "success");
        
        // --- CORREÇÃO AQUI ---
        // Chama a função correta que atualiza a tabela do seu sistema
        loadServiceOrders(); 
        
        // Se houver algum modal de detalhes aberto, fecha (evita erros)
        if(typeof closeOrderDetails === 'function') closeOrderDetails(); 
        if(typeof closeModal === 'function') closeModal();

    }).catch(error => {
        console.error("Erro ao concluir:", error);
        showToast("Erro ao concluir solicitação.", "error");
    });
}


// Função para Salvar a Cor escolhida
function saveFarmColor() {
    const fid = document.getElementById('map-admin-farm-select').value;
    const color = document.getElementById('farm-color-picker').value;

    if(!fid) {
        showToast("Selecione uma fazenda primeiro.", "error");
        return;
    }

    db.collection('fazendas').doc(fid).update({
        cor: color // Salva a cor no banco de dados
    }).then(() => {
        showToast("Cor da fazenda atualizada!", "success");
        // Recarrega o mapa para ver a mudança
        loadAdminMap(fid); 
    }).catch(e => {
        showToast("Erro ao salvar cor.", "error");
        console.error(e);
    });
}

//============================================
// 1. Função para Abrir/Fechar o Menu Lateral
//============================================

function toggleSidebar() {
    const sidebar = document.querySelector('.admin-sidebar');
    sidebar.classList.toggle('collapsed');
    
    // IMPORTANTE: Força o mapa a se ajustar ao novo espaço
    setTimeout(() => {
        if(adminMap) adminMap.invalidateSize();
        if(osMap) osMap.invalidateSize();
    }, 350); // Espera a animação do CSS terminar
}

// 2. Atualiza a cor da bolinha visualmente
function updateColorPreview(color) {
    const circle = document.getElementById('color-preview-circle');
    if(circle) {
        circle.style.backgroundColor = color;
    }
}


// Atualiza a cor da bolinha visualmente (Chamada pelo onchange do HTML)
function updateColorPreview(color) {
    const circle = document.getElementById('color-preview-circle');
    if(circle) {
        circle.style.backgroundColor = color;
    }
}

// Salva a cor no banco de dados (Chamada pelo botão de check)
function saveFarmColor() {
    const fid = document.getElementById('map-admin-farm-select').value;
    const color = document.getElementById('farm-color-picker').value;

    if(!fid) {
        showToast("Selecione uma fazenda primeiro.", "error");
        return;
    }

    db.collection('fazendas').doc(fid).update({
        cor: color
    }).then(() => {
        showToast("Cor atualizada!", "success");
        loadAdminMap(fid); // Recarrega para confirmar
    }).catch(e => {
        console.error(e);
        showToast("Erro ao salvar cor.", "error");
    });
}


// === SISTEMA OFFLINE RURAL ===

// 1. Salva a OS no LocalStorage (Memória do celular)
function saveOfflineOrder(orderData) {
    // Pega o que já tem salvo
    let pending = JSON.parse(localStorage.getItem('ds_offline_orders') || "[]");
    
    // Adiciona a nova (Como não tem serverTimestamp offline, usamos Date)
    orderData.createdAt = new Date(); 
    orderData.offlineCreated = true; // Marca que foi criado offline
    
    pending.push(orderData);
    
    // Salva de volta
    localStorage.setItem('ds_offline_orders', JSON.stringify(pending));
    
    alert("Sem internet! A solicitação foi salva no dispositivo e será enviada automaticamente quando o sinal voltar.");
    resetOSForm();
    updateOfflineBadge(); // Atualiza contador visual
}

// 2. Sincroniza quando a internet volta
function syncOfflineOrders() {
    const pending = JSON.parse(localStorage.getItem('ds_offline_orders') || "[]");
    
    if (pending.length === 0) return; // Nada para enviar

    showToast(`Sincronizando ${pending.length} pedidos...`, "info");

    const promises = pending.map(order => {
        // Remove a flag de controle antes de enviar
        delete order.offlineCreated;
        // Converte a data de string de volta para objeto data
        order.createdAt = new Date(order.createdAt); 
        
        return db.collection('service_orders').add(order);
    });

    Promise.all(promises).then(() => {
        // Se tudo deu certo, limpa a memória local
        localStorage.removeItem('ds_offline_orders');
        showToast("Todos os pedidos offline foram enviados!", "success");
        updateOfflineBadge();
        
        // Atualiza o histórico se estiver aberto
        if(!document.getElementById('client-history-modal').classList.contains('hidden')) {
            openClientHistory();
        }
    }).catch(err => {
        console.error("Erro na sincronização", err);
        showToast("Erro ao sincronizar alguns pedidos.", "error");
    });
}

// 3. Atualiza um aviso visual na tela (Opcional: Cria um ícone de nuvem)
function updateOfflineBadge() {
    const pending = JSON.parse(localStorage.getItem('ds_offline_orders') || "[]");
    const count = pending.length;
    
    // Tenta achar o badge ou cria um
    let badge = document.getElementById('offline-sync-badge');
    
    if (count > 0) {
        if(!badge) {
            // Cria o botãozinho flutuante de alerta
            badge = document.createElement('div');
            badge.id = 'offline-sync-badge';
            badge.style.cssText = "position:fixed; top:10px; left:50%; transform:translateX(-50%); background:#e67e22; color:white; padding:8px 15px; border-radius:20px; z-index:9999; font-size:12px; font-weight:bold; box-shadow:0 2px 5px rgba(0,0,0,0.2); display:flex; align-items:center; gap:5px; cursor:pointer;";
            badge.onclick = syncOfflineOrders; // Tenta forçar sync ao clicar
            document.body.appendChild(badge);
        }
        badge.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> ${count} Pendentes (Sem Sinal)`;
        badge.style.display = 'flex';
    } else {
        if(badge) badge.style.display = 'none';
    }
}

// === NAVEGAÇÃO INFERIOR (App Cliente) ===

// === NAVEGAÇÃO INFERIOR (App Cliente) ===

function switchClientTab(tabId) {
    // 1. Esconde todas as abas
    document.querySelectorAll('.client-tab-content').forEach(tab => {
        tab.classList.remove('active');
    });

    // 2. Desativa todos os botões de baixo
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.classList.remove('active');
    });

    // 3. Mostra a aba escolhida
    const targetTab = document.getElementById(tabId);
    if(targetTab) targetTab.classList.add('active');

    // 4. Ativa o botão correspondente
    const navButtons = document.querySelectorAll('.nav-item');
    if(tabId === 'tab-lista') navButtons[0].classList.add('active');
    if(tabId === 'tab-mapa') navButtons[1].classList.add('active');
    if(tabId === 'tab-perfil') navButtons[2].classList.add('active');

    // 5. LÓGICA DO BOTÃO FLUTUANTE (FAB)
    const fab = document.getElementById('fab-os-mobile');
    const totalSelected = document.querySelectorAll('.chk-export:checked').length;

    if (tabId === 'tab-perfil') {
        // Se for perfil, esconde o botão na marra, mesmo se tiver seleção
        fab.style.display = 'none'; 
    } else {
        // Se for Lista ou Mapa, volta a mostrar (mas só se tiver itens selecionados)
        fab.style.display = 'flex'; 
        
        // Verifica se deve aparecer ou ficar escondido (efeito de subir/descer)
        if (totalSelected > 0) {
            fab.classList.add('visible');
        } else {
            fab.classList.remove('visible');
        }
    }

    // 6. Recalcula tamanho do mapa se necessário
    if(tabId === 'tab-mapa' && map) {
        setTimeout(() => { map.invalidateSize(); }, 200);
    }
}


// Variável global para guardar a bolinha azul
let userLocationMarker = null;
let userLocationCircle = null;

// --- FUNÇÃO QUE CRIA O BOTÃO (ATUALIZADA) ---
function addLocationControl() {
    const LocationControl = L.Control.extend({
        options: { position: 'bottomright' },
        onAdd: function(map) {
            // AQUI ESTÁ O SEGREDO: Adicionei 'gps-control-box' para podermos alinhar a caixa
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control gps-control-box');
            
            const button = L.DomUtil.create('a', 'leaflet-control-locate', container);
            button.innerHTML = '<i class="fa-solid fa-crosshairs"></i>';
            button.href = "#";
            button.title = "Minha Localização";
            
            L.DomEvent.disableClickPropagation(button);
            L.DomEvent.on(button, 'click', function(e) {
                L.DomEvent.stop(e);
                button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                button.classList.add('locating-pulse');
                map.locate({setView: true, maxZoom: 16, enableHighAccuracy: true});
            });
            return container;
        }
    });
    if(map) map.addControl(new LocationControl());
}

// --- EVENTOS DO LEAFLET (Quando acha ou erra) ---

// 1. Se achar a localização
function onLocationFound(e) {
    const radius = e.accuracy / 2;
    const btnLocate = document.querySelector('.leaflet-control-locate');
    
    // Restaura o ícone do botão
    if(btnLocate) {
        btnLocate.innerHTML = '<i class="fa-solid fa-location-arrow" style="color:#2563eb"></i>';
        btnLocate.classList.remove('locating-pulse');
    }

    // Remove marcador anterior se existir
    if (userLocationMarker) map.removeLayer(userLocationMarker);
    if (userLocationCircle) map.removeLayer(userLocationCircle);

    // Adiciona bolinha azul e círculo de precisão
    userLocationMarker = L.marker(e.latlng, {
        icon: L.divIcon({
            className: 'custom-div-icon',
            html: "<div style='background-color:#4285F4; width:12px; height:12px; border-radius:50%; border:2px solid white; box-shadow: 0 0 5px rgba(0,0,0,0.5);'></div>",
            iconSize: [12, 12],
            iconAnchor: [6, 6]
        })
    }).addTo(map).bindPopup("Você está aqui (Precisão: " + Math.round(radius) + "m)").openPopup();

    userLocationCircle = L.circle(e.latlng, radius, {
        color: '#4285F4',
        fillColor: '#4285F4',
        fillOpacity: 0.1,
        weight: 1
    }).addTo(map);
}

// 2. Se der erro (ex: sem GPS)
function onLocationError(e) {
    alert("Não foi possível obter sua localização. Verifique se o GPS está ativado.");
    const btnLocate = document.querySelector('.leaflet-control-locate');
    if(btnLocate) {
        btnLocate.innerHTML = '<i class="fa-solid fa-crosshairs"></i>';
        btnLocate.classList.remove('locating-pulse');
    }
}

// =================================================================
// LÓGICA DA FOTO DE PERFIL (SALVA NO BANCO DE DADOS - FIRESTORE)
// =================================================================

// 1. Salvar Foto como Texto no Banco de Dados
function saveProfilePhoto(input) {
    const user = firebase.auth().currentUser;
    
    if (!user) {
        alert("Faça login para mudar a foto.");
        return;
    }

    if (input.files && input.files[0]) {
        const file = input.files[0];
        
        // Mostra ícone carregando
        const iconElement = document.getElementById('profile-icon');
        if(iconElement) iconElement.className = "fa-solid fa-spinner fa-spin";

        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.src = e.target.result;
            
            img.onload = function() {
                // --- COMPRESSÃO OBRIGATÓRIA ---
                // O Firestore tem limite de tamanho, então precisamos reduzir bem a foto
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                
                // Tamanho fixo de 200px (Suficiente para perfil e fica leve)
                const maxWidth = 200; 
                const scaleFactor = maxWidth / img.width;
                
                canvas.width = maxWidth;
                canvas.height = img.height * scaleFactor;
                
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                
                // Converte para texto Base64 (Qualidade 0.6)
                const base64String = canvas.toDataURL('image/jpeg', 0.6);
                
                // --- SALVA NO FIRESTORE (DB) ---
                // Em vez de salvar arquivo, salvamos esse texto gigante no cadastro do usuário
                db.collection('users').doc(user.uid).set({
                    avatar: base64String
                }, { merge: true }) // merge: true garante que não apague outros dados (nome, email)
                .then(() => {
                    console.log("Foto salva no banco de dados!");
                    loadProfilePhoto(); // Atualiza a tela
                    alert("Foto atualizada em todos os dispositivos!");
                })
                .catch((error) => {
                    console.error("Erro ao salvar:", error);
                    alert("Erro ao salvar foto.");
                    if(iconElement) iconElement.className = "fa-solid fa-user";
                });
            }
        }
        reader.readAsDataURL(file);
    }
}

// 2. Carregar Foto do Banco de Dados
function loadProfilePhoto() {
    firebase.auth().onAuthStateChanged((user) => {
        if (user) {
            const imgElement = document.getElementById('profile-image');
            const iconElement = document.getElementById('profile-icon');
            
            // Busca os dados do usuário no Firestore
            db.collection('users').doc(user.uid).onSnapshot((doc) => {
                if (doc.exists && doc.data().avatar) {
                    // Se tiver foto salva no banco
                    const photoBase64 = doc.data().avatar;
                    
                    if (imgElement && iconElement) {
                        imgElement.src = photoBase64;
                        imgElement.style.display = 'block';
                        iconElement.style.display = 'none';
                    }
                } else {
                    // Se não tiver foto
                    if(imgElement) imgElement.style.display = 'none';
                    if(iconElement) {
                        iconElement.style.display = 'flex'; // Flex para centralizar
                        iconElement.className = "fa-solid fa-user";
                    }
                }
            });
        }
    });
}

// Função para mostrar/esconder o campo "Outros"
function checkOtherOption(selectElement) {
    const customInput = document.getElementById('os-type-custom');
    
    if (selectElement.value === 'Outros') {
        customInput.style.display = 'block'; // Mostra
        customInput.focus(); // Já coloca o cursor lá pra digitar
    } else {
        customInput.style.display = 'none';  // Esconde
        customInput.value = ''; // Limpa o que estava escrito se mudar de ideia
    }
}

// ============================================
// ESTATÍSTICAS DO PERFIL (NOVO)
// ============================================

function loadClientProfileStats(uid) {
    const container = document.getElementById('profile-stats-area');
    if (!container) return;

    // Busca as fazendas do cliente no banco
    db.collection('fazendas').where('donoUID', '==', uid).get().then(snap => {
        if (snap.empty) {
            container.innerHTML = "<p style='text-align:center; color:#777;'>Nenhuma fazenda cadastrada.</p>";
            return;
        }

        let totalFarms = 0;
        let totalGeneralHectares = 0;
        let farmsHTML = "";

        // Prepara array para ordenar
        let farms = [];
        snap.forEach(doc => farms.push(doc.data()));
        farms.sort((a, b) => (a.numero || 0) - (b.numero || 0));

        // Loop pelas fazendas
        farms.forEach(f => {
            totalFarms++;
            let farmArea = 0;
            let plotsHTML = "";
            
            // Ordena os talhões
            const sortedTalhoes = f.talhoes ? f.talhoes.sort((a,b) => a.numero - b.numero) : [];

            // Loop pelos talhões para calcular área e montar lista
            sortedTalhoes.forEach(t => {
                try {
                    const geoData = JSON.parse(t.geometry);
                    const areaM2 = turf.area(geoData);
                    const areaHa = (areaM2 / 10000); // Converte m² para Hectares
                    
                    farmArea += areaHa;
                    
                    const tName = t.nomeOriginal || `Talhão ${t.numero}`;
                    
                    plotsHTML += `
                        <div class="plot-stat-row">
                            <span><i class="fa-solid fa-draw-polygon" style="font-size:0.8em; margin-right:5px; opacity:0.5;"></i> ${tName}</span>
                            <strong>${areaHa.toFixed(2)} ha</strong>
                        </div>
                    `;
                } catch (e) { console.error(e); }
            });

            totalGeneralHectares += farmArea;
            const fNum = String(f.numero).padStart(2, '0');

            // HTML DO CARD DA FAZENDA
            // Usamos um onclick simples para abrir/fechar os detalhes
            farmsHTML += `
                <div class="farm-stat-card" id="stat-card-${fNum}">
                    <div class="farm-stat-header" onclick="toggleStatCard(this)">
                        <div class="farm-info-left">
                            <strong>F${fNum} - ${f.nome}</strong>
                            <small>${sortedTalhoes.length} talhões</small>
                        </div>
                        <div class="farm-info-right">
                            <span class="farm-total-area">${farmArea.toFixed(2)} ha</span>
                            <i class="fa-solid fa-chevron-down toggle-icon"></i>
                        </div>
                    </div>
                    <div class="farm-stat-details">
                        ${plotsHTML || '<small>Sem talhões demarcados</small>'}
                    </div>
                </div>
            `;
        });

        // MONTA O HTML FINAL
        const finalHTML = `
            <div class="stats-summary-grid">
                <div class="stat-card-main">
                    <h3>${totalFarms}</h3>
                    <p>Fazendas</p>
                </div>
                <div class="stat-card-main">
                    <h3>${totalGeneralHectares.toFixed(2)}</h3>
                    <p>Total Hectares</p>
                </div>
            </div>

            <h4 style="margin: 20px 0 10px 0; font-size: 0.9rem; color: var(--text-light); text-transform: uppercase;">Detalhamento por Fazenda</h4>
            
            <div>
                ${farmsHTML}
            </div>
        `;

        container.innerHTML = finalHTML;
    });
}

// Pequena função auxiliar para o efeito de abrir/fechar (Acordeão)
function toggleStatCard(headerElement) {
    const card = headerElement.parentElement;
    card.classList.toggle('open');
}

// Inicializa
document.addEventListener('DOMContentLoaded', loadProfilePhoto);

// 4. "Ouvintes" de Conexão
window.addEventListener('online', () => {
    showToast("Internet restabelecida. Sincronizando...", "info");
    syncOfflineOrders();
});

window.addEventListener('load', () => {
    updateOfflineBadge();
    // Tenta sincronizar ao abrir o app se tiver internet
    if(navigator.onLine) syncOfflineOrders();
});