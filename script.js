// === CONFIGURAÇÃO ===
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

const app = firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const secondaryApp = firebase.initializeApp(firebaseConfig, "Secondary");
const secondaryAuth = secondaryApp.auth();

// Variáveis Globais
let map, adminMap, osMap; 
let osLayers = L.layerGroup();
let osLabels = L.layerGroup();
let isPreviewMode = false;
let loadedOSFeatures = [];
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

function login() { const e = document.getElementById('email').value; const p = document.getElementById('password').value; auth.signInWithEmailAndPassword(e, p).catch(err => alert("Erro: " + err.message)); }
function logout() { auth.signOut(); location.reload(); }
function toggleTheme() { document.body.classList.toggle('dark-mode'); localStorage.setItem('ds-theme', document.body.classList.contains('dark-mode') ? 'dark' : 'light'); updateThemeIcons(document.body.classList.contains('dark-mode')); }
function updateThemeIcons(isDark) { document.querySelectorAll('.fa-moon, .fa-sun').forEach(icon => { if (isDark) { icon.classList.remove('fa-moon'); icon.classList.add('fa-sun'); } else { icon.classList.remove('fa-sun'); icon.classList.add('fa-moon'); } }); }

// ============================================
// CLIENTE
// ============================================
function initMap() {
    if(map) return;
    
    // Configuração Inicial do Mapa
    map = L.map('map', {zoomControl: false}).setView([-14.2350, -51.9253], 4);
    
    L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',{
        maxZoom: 20, 
        subdomains:['mt0','mt1','mt2','mt3']
    }).addTo(map);
    
    L.control.zoom({position: 'bottomright'}).addTo(map);

    // --- NOVA LÓGICA INTELIGENTE DE ZOOM ---
    function checkZoomLevel() {
        const currentZoom = map.getZoom();
        const mapElement = document.getElementById('map');
        
        // Se o zoom for MENOR que 14 (muito longe/alto), esconde os nomes
        if (currentZoom < 14) {
            mapElement.classList.add('hide-labels');
        } else {
            // Se estiver perto (14 ou mais), mostra os nomes
            mapElement.classList.remove('hide-labels');
        }
    }

    // Ouve o evento de zoom (cada vez que muda o zoom, roda a verificação)
    map.on('zoomend', checkZoomLevel);

    // Roda uma vez logo que abre para garantir o estado inicial
    checkZoomLevel();
}

function loadClientFarms(uid) {
    const list = document.getElementById('farms-list');
    list.innerHTML = "<div style='text-align:center; padding:20px; color:#777'><i class='fa-solid fa-circle-notch fa-spin'></i> Carregando mapas...</div>";
    
    db.collection('fazendas').where('donoUID', '==', uid).get().then(snap => {
        list.innerHTML = "";
        if(snap.empty) { 
            list.innerHTML = "<div style='padding:20px; text-align:center; color:#777'>Nenhuma fazenda encontrada.</div>"; 
            return; 
        }
        
        const bounds = L.latLngBounds();
        let hasLayers = false;
        
        snap.forEach(doc => {
            const f = doc.data();
            const fNum = String(f.numero).padStart(2,'0');
            
            // 1. Cria o Grupo da Fazenda
            const groupDiv = document.createElement('div');
            groupDiv.className = 'farm-group'; // Classe principal

            // 2. Cria o Cabeçalho (Onde o usuário clica)
            const headerDiv = document.createElement('div');
            headerDiv.className = 'farm-header';
            headerDiv.innerHTML = `
                <span>F${fNum} - ${f.nome}</span>
                <i class="fa-solid fa-chevron-down farm-arrow"></i>
            `;

            // 3. Cria o Container de Conteúdo (Oculto por CSS)
            const contentDiv = document.createElement('div');
            contentDiv.className = 'farm-content';

            // EVENTO DE CLIQUE PARA ABRIR/FECHAR
            headerDiv.addEventListener('click', () => {
                // Fecha outras fazendas se quiser (opcional, deixei comentado)
                // document.querySelectorAll('.farm-group').forEach(g => { if(g !== groupDiv) g.classList.remove('open') });
                
                groupDiv.classList.toggle('open');
            });

            const sortedTalhoes = f.talhoes ? f.talhoes.sort((a,b) => a.numero - b.numero) : [];

            sortedTalhoes.forEach(t => {
    try {
        let geoData = (typeof t.geometry === 'string') ? JSON.parse(t.geometry) : t.geometry;
        const displayName = t.nomeOriginal && t.nomeOriginal.length > 0 ? t.nomeOriginal : `Talhão ${t.numero}`;
        
        // --- CORREÇÃO: O CÁLCULO VEM PRIMEIRO ---
        // 1. Calcula a área em Hectares AGORA (antes de usar no HTML)
        const areaM2 = turf.area(geoData);
        const areaHa = (areaM2 / 10000).toFixed(2); 
        // ----------------------------------------

        const row = document.createElement('div');
        row.className = 'plot-item';
        
        // Agora podemos usar ${areaHa} porque ela já foi criada nas linhas acima
        row.innerHTML = `<input type="checkbox" class="chk-export" 
            data-farm-id="${doc.id}" 
            data-farm-name="${f.nome}"
            data-farm-num="${f.numero}"
            data-plot-name="${displayName}"
            data-plot-area="${areaHa}"> <span>${displayName}</span>`;
        
        // --- MAPA: CRIAÇÃO DO POLÍGONO E RÓTULO ---
        
        // 2. Adiciona ao mapa
        const poly = L.geoJSON(geoData, {style: {color:'#ffffff', weight:2, fillOpacity:0.1}}).addTo(map);
        
        // Restante do código continua igual...
        poly.bindTooltip(`${displayName}<br><span style="font-size:0.9em">${areaHa} ha</span>`, {
            permanent: true, 
            direction: 'center', 
            className: 'client-plot-label' 
        });
        
        

                    bounds.extend(poly.getBounds());
                    hasLayers = true;
                    // -------------------------------------------
                    
                    const checkbox = row.querySelector('input');
                    checkbox.addEventListener('change', e => {
                        if(e.target.checked) {
                            poly.setStyle({color: '#ffcc00', weight: 3, fillOpacity: 0.6});
                            row.classList.add('active');
                        } else {
                            poly.setStyle({color: '#ffffff', weight: 2, fillOpacity: 0.1});
                            row.classList.remove('active');
                        }
                        
						// --- LÓGICA DO BOTÃO FLUTUANTE MOBILE ---
                        const totalSelected = document.querySelectorAll('.chk-export:checked').length;
                        const fab = document.getElementById('fab-os-mobile');
                        const fabCount = document.getElementById('fab-count');

                        if(fab && fabCount) {
                            fabCount.innerText = totalSelected; // Atualiza o contador (1, 2, 3...)
                            
                            // Se tiver pelo menos 1 selecionado E for mobile (opcional), mostra o botão
                            if(totalSelected > 0) {
                                fab.classList.add('visible');
                            } else {
                                fab.classList.remove('visible');
                            }
                        }
					
					
					});

                    row.addEventListener('click', (e) => {
                        if(e.target.type !== 'checkbox') {
                            map.fitBounds(poly.getBounds());
                            if(window.innerWidth <= 768) toggleMobileSidebar();
                        }
                    });

                    poly.on('click', () => {
                        checkbox.checked = !checkbox.checked;
                        checkbox.dispatchEvent(new Event('change'));
                        groupDiv.classList.add('open');
                        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    });

                    contentDiv.appendChild(row);
                } catch(e){ console.warn("Erro ao ler talhão:", e); }
            });

            // Monta a estrutura final
            groupDiv.appendChild(headerDiv);
            groupDiv.appendChild(contentDiv);
            list.appendChild(groupDiv);
        });
        
        if(hasLayers) setTimeout(() => { map.fitBounds(bounds); }, 500);
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
    
    // Abre a modal
    document.getElementById('new-os-modal').classList.remove('hidden');
}

// 2. Função para Fechar a Janela
function closeOSModal() {
    document.getElementById('new-os-modal').classList.add('hidden');
}

// 3. Função chamada pelo botão "Enviar Pedido" (Salva no Firebase)
function finalizeOS() {
    const type = document.getElementById('os-type-input').value;
    
    if(!type) {
        alert("Por favor, selecione o Tipo de Aplicação.");
        return;
    }

    const user = firebase.auth().currentUser;
    const clientName = document.getElementById('client-name-display').innerText;
    const btnSend = document.querySelector('#new-os-modal .btn-success');
    
    // Feedback visual (Desabilita botão para não clicar 2x)
    const originalText = btnSend.innerText;
    btnSend.innerText = "Enviando...";
    btnSend.disabled = true;

    db.collection('service_orders').add({
        clientUid: user.uid,
        clientName: clientName,
        status: 'pendente',
        tipoAplicacao: type, // <--- CAMPO NOVO AQUI
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        items: pendingOSItems
    }).then(() => {
        alert("Solicitação enviada com sucesso!");
        
        // Limpa tudo
        document.querySelectorAll('.chk-export:checked').forEach(c => { 
            c.checked = false; 
            c.dispatchEvent(new Event('change')); 
        });
        
        closeOSModal();
        
        // Restaura botão
        btnSend.innerText = originalText;
        btnSend.disabled = false;
        
    }).catch(e => {
        alert("Erro ao enviar: " + e);
        btnSend.innerText = originalText;
        btnSend.disabled = false;
    });
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
    
    // Troquei alert por showToast error
    if(!nome || !numero || !uid || !file) {
        showToast("Por favor, preencha todos os campos.", "error");
        return;
    }
    
    const text = await file.text();
    const geojson = toGeoJSON.kml(new DOMParser().parseFromString(text, 'text/xml'));
    const talhoes = [];
    
    geojson.features.forEach((f, i) => {
        if(f.geometry && f.geometry.type.includes('Polygon')) {
            let raw = f.properties.plot_name || f.properties.Name || f.properties.name || `Talhão ${i+1}`;
            let tNum = i + 1;
            if(raw) {
                let match = raw.toString().match(/(\d+)/);
                if(match) tNum = parseInt(match[0]);
            }
            talhoes.push({ numero: tNum, nomeOriginal: raw, geometry: JSON.stringify(f.geometry) });
        }
    });
    
    // Troquei alert por showToast error
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
        // --- AQUI ESTÁ A MUDANÇA PRINCIPAL ---
        showToast("Fazenda cadastrada com sucesso!", "success");
        
        // Limpa os campos
        document.getElementById('farm-name').value = '';
        document.getElementById('farm-number').value = '';
        document.getElementById('kml-file').value = '';
        document.getElementById('file-name-display').innerText = '';
        
        // Atualiza a lista no mapa se o cliente estiver selecionado
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
    
    adminMap = L.map('admin-map').setView([-14,-52],4); 
    
    L.tileLayer('https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',{
        maxZoom:20,
        subdomains:['mt0','mt1','mt2','mt3']
    }).addTo(adminMap); 
    
    // --- LÓGICA DE ZOOM INTELIGENTE ---
    adminMap.on('zoomend', function() {
        const zoom = adminMap.getZoom();
        const mapDiv = document.getElementById('admin-map');
        
        // Se o zoom for menor que 13 (muito alto/longe), esconde os textos
        if (zoom < 16) { // ZOM PRA VER OS NOMES
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
    if(!fid) return;
    
    const farmColors = [
        '#e74c3c', '#8e44ad', '#3498db', '#1abc9c', '#f1c40f', 
        '#e67e22', '#2ecc71', '#d35400', '#2980b9', '#c0392b',
        '#9b59b6', '#16a085', '#f39c12', '#27ae60', '#7f8c8d', 
        '#2c3e50', '#e84393', '#00cec9', '#6c5ce7', '#fdcb6e', 
        '#d63031', '#0984e3', '#00b894', '#ffeaa7', '#ff7675', 
        '#a29bfe', '#636e72', '#55efc4', '#fd79a8', '#fab1a0'
    ];

    db.collection('fazendas').doc(fid).get().then(doc => {
        const f = doc.data(); 
        const b = L.latLngBounds();
        
        if(adminMap) adminMap.eachLayer(l => { if(!l._url) adminMap.removeLayer(l) });
        
        const colorIndex = f.numero ? f.numero : 0;
        const currentColor = farmColors[colorIndex % farmColors.length];

        f.talhoes.forEach(t => { 
            try {
                const geoData = JSON.parse(t.geometry);
                // AQUI: Usa somente o nome original do KML
                const displayName = t.nomeOriginal || `Talhão ${t.numero}`;
                
                const areaM2 = turf.area(geoData);
                const areaHa = (areaM2 / 10000).toFixed(2);

                const p = L.geoJSON(geoData, {
                    style: { color: '#000000', weight: 1, fillColor: currentColor, fillOpacity: 0.8 }
                }).addTo(adminMap);
                
                // --- RÓTULO LIMPO (Nome + Área) ---
                const center = turf.centerOfMass(geoData);
                const labelHtml = `
                    <div>
                        <span style="font-size:12px">${displayName}</span><br>
                        <span style="font-size:10px">${areaHa} ha</span>
                    </div>
                `;
                
                const labelIcon = L.divIcon({ className: 'admin-map-label', html: labelHtml, iconSize: [0,0] });
                L.marker([center.geometry.coordinates[1], center.geometry.coordinates[0]], {icon: labelIcon}).addTo(adminMap);
                
                // Tooltip continua com informação completa ao passar o mouse
                p.bindTooltip(`<strong>${displayName}</strong> (${areaHa} ha)`, { direction: 'top' }); 
                
                b.extend(p.getBounds());
            } catch(e){} 
        });
        
        if(f.talhoes.length) adminMap.fitBounds(b);
    });
}

function loadAllFarmsOnMap() {
    if(!adminMap) initAdminMap(); 
    
    adminMap.eachLayer(l => { if(!l._url) adminMap.removeLayer(l) });
    document.getElementById('map-admin-client-select').value = ""; 
    document.getElementById('map-admin-farm-select').disabled = true;

    const farmColors = [
        '#e74c3c', '#8e44ad', '#3498db', '#1abc9c', '#f1c40f', 
        '#e67e22', '#2ecc71', '#d35400', '#2980b9', '#c0392b',
        '#9b59b6', '#16a085', '#f39c12', '#27ae60', '#7f8c8d', 
        '#2c3e50', '#e84393', '#00cec9', '#6c5ce7', '#fdcb6e', 
        '#d63031', '#0984e3', '#00b894', '#ffeaa7', '#ff7675', 
        '#a29bfe', '#636e72', '#55efc4', '#fd79a8', '#fab1a0'
    ];

    db.collection('fazendas').get().then(snap => {
        const b = L.latLngBounds(); 
        let c = 0;

        snap.forEach(doc => {
            const f = doc.data();
            const colorIndex = f.numero ? f.numero : 0;
            const currentColor = farmColors[colorIndex % farmColors.length];
            
            f.talhoes.forEach(t => { 
                try {
                    const geoData = JSON.parse(t.geometry);
                    // AQUI: Usa somente o nome original do KML
                    const displayName = t.nomeOriginal || `Talhão ${t.numero}`;
                    const areaM2 = turf.area(geoData);
                    const areaHa = (areaM2 / 10000).toFixed(2);

                    const p = L.geoJSON(geoData, {
                        style: { color: '#000000', weight: 1, fillColor: currentColor, fillOpacity: 0.7 } // --> COR DA BORDA DO MAPA //
                    }).addTo(adminMap);
                    
                    // --- RÓTULO LIMPO ---
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
            zoomSnap: 0.1, zoomDelta: 0.1, wheelPxPerZoomLevel: 120
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
    document.getElementById('cfg-title-text').value = `OS - ${osData.clientName}`;
    updateOSTitle();

    // --- LIMPA A LISTA GLOBAL DE DADOS ---
    loadedOSFeatures = []; 
    // -------------------------------------

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

            f.talhoes.forEach(t => {
                const dbName = t.nomeOriginal || `Talhão ${t.numero}`;
                
                if(targetNames.includes(dbName)) {
                    try {
                        const geoData = JSON.parse(t.geometry);
                        const area = turf.area(geoData) / 10000;
                        
                        // --- SALVA OS DADOS NA LISTA GLOBAL ---
                        loadedOSFeatures.push({
                            type: 'Feature',
                            properties: {
                                farmName: f.nome,
                                farmNumber: f.numero,
                                plotName: dbName,
                                plotNumber: t.numero,
                                areaHa: area.toFixed(2),
                                color: color
                            },
                            geometry: geoData
                        });
                        // --------------------------------------

                        const poly = L.geoJSON(geoData, {
                            style: { color: 'black', weight: 1, fillColor: color, fillOpacity: 1 }
                        });
                        
                        farmHectares += area;
                        totalHectares += area;

                        poly.addTo(osLayers);
                        bounds.extend(poly.getBounds());

                        const fNum = String(f.numero).padStart(2,'0'); 
                        const tNum = String(t.numero).padStart(2,'0');
                        const labelTitle = `F${fNum} T${tNum}`; 

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
function printOS() { if(!isPreviewMode) { toggleOSPreviewMode(); setTimeout(()=>window.print(),1000); } else window.print(); }
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

    // Preenche os dados básicos
    document.getElementById('detail-client').innerText = order.clientName;
    document.getElementById('detail-date').innerText = "Data: " + new Date(order.createdAt.seconds * 1000).toLocaleDateString('pt-BR');
    document.getElementById('detail-type').innerText = order.tipoAplicacao || "Não informado";
    
    const statusEl = document.getElementById('detail-status');
    statusEl.innerText = order.status.toUpperCase();
    
    // Cores do Status
    if(order.status === 'concluido') statusEl.style.color = 'green';
    else if(order.status === 'cancelado') statusEl.style.color = 'red';
    else statusEl.style.color = '#333';

    // --- CÁLCULOS DO RESUMO ---
    let totalArea = 0;
    const uniqueFarms = new Set(); // O Set guarda apenas valores únicos
    
    // Limpa e prepara a tabela
    const tbody = document.getElementById('detail-items-list');
    tbody.innerHTML = "";

    order.items.forEach(item => {
        const fName = item.farmName || "-";
        const fNum = item.farmNum ? String(item.farmNum).padStart(2,'0') : "00";
        const tName = item.realName || "Talhão Sem Nome";
        
        // 1. Adiciona nome da fazenda no Set (para contar quantas fazendas únicas)
        if(item.farmName) uniqueFarms.add(item.farmName);

        // 2. Soma a área (se existir)
        let areaDisplay = "";
        if (item.area && item.area !== "undefined" && item.area !== null) {
            const val = parseFloat(item.area); // Converte texto "15.50" para número
            if(!isNaN(val)) totalArea += val;
            areaDisplay = `<strong style="margin-left:5px;">(${item.area} ha)</strong>`;
        }

        // 3. Cria a linha da tabela
        tbody.innerHTML += `
            <tr>
                <td>${fName}</td>
                <td>F${fNum}</td>
                <td>${tName} ${areaDisplay}</td>
            </tr>
        `;
    });

    // --- INJETAR O RESUMO NO HTML ---
    // Vamos usar a div 'report-info-box' que já existe para mostrar o resumo
    const infoBox = document.querySelector('.report-info-box');
    
    // Mantém os dados do cliente e ADICIONA o resumo embaixo, com uma linha separadora
    infoBox.innerHTML = `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <div>
                <p><strong>Cliente:</strong> ${order.clientName}</p>
                <p><strong>Tipo:</strong> <span class="highlight-type">${order.tipoAplicacao || '-'}</span></p>
                <p><strong>Status:</strong> ${order.status.toUpperCase()}</p>
            </div>
            <div style="border-left: 2px solid #ddd; padding-left: 15px; display: flex; flex-direction: column; justify-content: center;">
                <h4 style="margin: 0 0 5px 0; color: #0f172a;">RESUMO GERAL</h4>
                <p style="margin: 2px 0;"><strong>Fazendas:</strong> ${uniqueFarms.size}</p>
                <p style="margin: 2px 0;"><strong>Talhões:</strong> ${order.items.length}</p>
                <p style="margin: 2px 0; font-size: 1.1em; color: var(--primary);"><strong>Total Área:</strong> ${totalArea.toFixed(2)} ha</p>
            </div>
        </div>
    `;

    // Abre a modal
    document.getElementById('order-details-modal').classList.remove('hidden');
}

function closeOrderDetails() {
    document.getElementById('order-details-modal').classList.add('hidden');
}

function printOrderReport() {
    window.print();
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