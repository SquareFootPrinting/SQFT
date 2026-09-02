// CART-LOGIC.JS 
window.currentFileUrl = "";
window.currentFileName = ""; 

async function handleImmediateUpload(event, buttonId) {
    const file = event.target.files[0];
    const btn = document.getElementById(buttonId);
    
    if (!file) return;

    // Feedback visual para el cliente
    if (btn) {
        btn.disabled = true;
        btn.innerText = "UPLOADING ARTWORK...";
        btn.style.opacity = "0.5";
        btn.style.cursor = "not-allowed";
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch('https://ft-f34l.onrender.com/api/upload-preview', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (data.success) {
            window.currentFileUrl = data.url; // Guardamos el link de Cloudinary
            window.currentFileName = data.originalName || file.name || "";
            console.log("✅ File ready:", window.currentFileUrl);
            
            if (btn) {
                btn.disabled = false;
                btn.innerText = "ADD TO CART";
                btn.style.opacity = "1";
                btn.style.cursor = "pointer";
            }
        } else {
            throw new Error(data.error);
        }
    } catch (error) {
        alert("Upload failed. Please try again.");
        if (btn) {
            btn.disabled = false;
            btn.innerText = "RETRY UPLOAD";
        }
    }
}

function addToCartWithFile(productData) {
    if (!window.currentFileUrl) {
        alert("Please upload your design before adding to cart.");
        return;
    }

    const cart = JSON.parse(localStorage.getItem('sqft_cart')) || [];
    
    // Unimos los datos del producto con la URL de la imagen
    const finalProduct = {
        ...productData,
        image: productData.image || '../images/placeholder.png', // Miniatura del producto
        fileUrl: window.currentFileUrl, // El archivo de alta resolución para imprimir
        originalFileName: window.currentFileName || ""
    };

    cart.push(finalProduct);
    localStorage.setItem('sqft_cart', JSON.stringify(cart));
    
    // Actualizamos el contador del carrito si existe la función
    if (typeof renderCart === 'function') renderCart();
    
    alert("Added to bag successfully!");
}