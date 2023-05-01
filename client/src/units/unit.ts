import { Marker, LatLng, Polyline, Icon, DivIcon, CircleMarker } from 'leaflet';
import { getMap, getUnitsManager } from '..';
import { rad2deg } from '../other/utils';
import { addDestination, attackUnit, changeAltitude, changeSpeed, createFormation as setLeader, deleteUnit, getUnits, landAt, setAltitude, setReactionToThreat, setROE, setSpeed, refuel, setAdvacedOptions, followUnit } from '../server/server';
import { aircraftDatabase } from './aircraftdatabase';
import { groundUnitsDatabase } from './groundunitsdatabase';
import { field } from 'geomag'

var pathIcon = new Icon({
    iconUrl: 'images/marker-icon.png',
    shadowUrl: 'images/marker-shadow.png',
    iconAnchor: [13, 41]
});

export class Unit extends Marker {
    ID: number;

    #data: UnitData = {
        baseData: {
            AI: false,
            name: "",
            unitName: "",
            groupName: "",
            alive: true,
            category: "",
        },
        flightData: {
            latitude: 0,
            longitude: 0,
            altitude: 0,
            heading: 0,
            speed: 0,
        },
        missionData: {
            fuel: 0,
            flags: {},
            ammo: {},
            targets: {},
            hasTask: false,
            coalition: "",
        },
        formationData: {
            leaderID: 0
        },
        taskData: {
            currentState: "IDLE",
            currentTask: "",
            activePath: {},
            targetSpeed: 0,
            targetAltitude: 0,
            isTanker: false,
            isAWACS: false,
            TACANOn: false,
            TACANChannel: 0,
            TACANXY: "X",
            TACANCallsign: "",
            radioFrequency: 0,
            radioCallsign: 0,
            radioCallsignNumber: 0,
            radioAMFM: "AM"
        },
        optionsData: {
            ROE: "",
            reactionToThreat: "",
        }
    };

    #selectable: boolean;
    #selected: boolean = false;
    #hovered: boolean = false;
    #hidden: boolean = false;

    #preventClick: boolean = false;

    #pathMarkers: Marker[] = [];
    #pathPolyline: Polyline;
    #targetsPolylines: Polyline[];
    #miniMapMarker: CircleMarker | null = null;

    #timer: number = 0;

    static getConstructor(type: string) {
        if (type === "GroundUnit") return GroundUnit;
        if (type === "Aircraft") return Aircraft;
        if (type === "Helicopter") return Helicopter;
        if (type === "Missile") return Missile;
        if (type === "Bomb") return Bomb;
        if (type === "NavyUnit") return NavyUnit;
    }

    constructor(ID: number, data: UpdateData) {
        super(new LatLng(0, 0), { riseOnHover: true, keyboard: false });

        this.ID = ID;

        this.#selectable = true;
        
        this.on('click', (e) => this.#onClick(e));
        this.on('dblclick', (e) => this.#onDoubleClick(e));
        this.on('contextmenu', (e) => this.#onContextMenu(e));
        this.on('mouseover', () => { this.#hovered = true;})
        this.on('mouseout', () => { this.#hovered = false;})
        
        this.#pathPolyline = new Polyline([], { color: '#2d3e50', weight: 3, opacity: 0.5, smoothFactor: 1 });
        this.#pathPolyline.addTo(getMap());
        this.#targetsPolylines = [];

        /* Deselect units if they are hidden */
        document.addEventListener("toggleCoalitionVisibility", (ev: CustomEventInit) => {
            window.setTimeout(() => {this.setSelected(this.getSelected() && !this.getHidden())}, 300);
        });
    
        document.addEventListener("toggleUnitVisibility", (ev: CustomEventInit) => {
            window.setTimeout(() => {this.setSelected(this.getSelected() && !this.getHidden())}, 300);
        });

        /* Set the unit data */
        this.setData(data);

        /* Set the icon */
        var icon = new DivIcon({
            html: this.getMarkerHTML(),
            className: 'leaflet-unit-marker',
            iconAnchor: [25, 25],
            iconSize: [50, 50],
        });
        this.setIcon(icon);
    }

    getMarkerHTML() {
        return  `<div class="unit" data-object="unit-${this.getMarkerCategory()}" data-coalition="${this.getMissionData().coalition}">
                    <div class="unit-selected-spotlight"></div>
                    <div class="unit-marker"></div>
                    <div class="unit-short-label"></div>
                </div>`
    }

    getMarkerCategory()
    {
        // Overloaded by child classes
        return "";
    }

    setData(data: UpdateData) {
        /* Check if data has changed comparing new values to old values */
        const positionChanged = (data.flightData.latitude != undefined && data.flightData.longitude != undefined && (this.getFlightData().latitude != data.flightData.latitude || this.getFlightData().longitude != data.flightData.longitude));
        const headingChanged = (data.flightData.heading != undefined && this.getFlightData().heading != data.flightData.heading);
        const aliveChanged = (data.baseData.alive != undefined && this.getBaseData().alive != data.baseData.alive);
        var updateMarker = (positionChanged || headingChanged || aliveChanged || !getMap().hasLayer(this))
        
        if (data.baseData != undefined)
        {
            for (let key in this.#data.baseData)
                if (key in data.baseData)
                    //@ts-ignore
                    this.#data.baseData[key] = data.baseData[key];
        }

        if (data.flightData != undefined)
        {
            for (let key in this.#data.flightData)
                if (key in data.flightData)
                    //@ts-ignore
                    this.#data.flightData[key] = data.flightData[key];
        }

        if (data.missionData != undefined)
        {
            for (let key in this.#data.missionData)
                if (key in data.missionData)
                    //@ts-ignore
                    this.#data.missionData[key] = data.missionData[key];
        }

        if (data.formationData != undefined)
        {
            for (let key in this.#data.formationData)
                if (key in data.formationData)
                    //@ts-ignore
                    this.#data.formationData[key] = data.formationData[key];
        }

        if (data.taskData != undefined)
        {
            for (let key in this.#data.taskData)
                if (key in data.taskData)
                    //@ts-ignore
                    this.#data.taskData[key] = data.taskData[key];
        }

        if (data.optionsData != undefined)
        {
            for (let key in this.#data.optionsData)
                if (key in data.optionsData)
                    //@ts-ignore
                    this.#data.optionsData[key] = data.optionsData[key];
        }

        /* Dead units can't be selected */
        this.setSelected(this.getSelected() && this.getBaseData().alive && !this.getHidden())

        if (updateMarker)
            this.#updateMarker();

        this.#clearTargets();
        if (this.getSelected()) {
            this.#drawPath();
            this.#drawTargets();
        }
        else
            this.#clearPath();

        document.dispatchEvent(new CustomEvent("unitUpdated", { detail: this }));
    }

    getData() {
        return this.#data;
    }

    getBaseData() {
        return this.getData().baseData;
    }

    getFlightData() {
        return this.getData().flightData;
    }

    getTaskData() {
        return this.getData().taskData;
    }

    getMissionData() {
        return this.getData().missionData;
    }

    getFormationData() {
        return this.getData().formationData;
    }

    getOptionsData() {
        return this.getData().optionsData;
    }

    setSelected(selected: boolean) {
        /* Only alive units can be selected. Some units are not selectable (weapons) */
        if ((this.getBaseData().alive || !selected) && this.getSelectable() && this.getSelected() != selected) {
            this.#selected = selected;
            this.getElement()?.querySelector(`[data-object|="unit"]`)?.toggleAttribute("data-is-selected");
            if (selected)
                document.dispatchEvent(new CustomEvent("unitSelection", { detail: this }));
            else
                document.dispatchEvent(new CustomEvent("unitDeselection", { detail: this }));
        }
    }

    getSelected() {
        return this.#selected;
    }

    setSelectable(selectable: boolean) {
        this.#selectable = selectable;
    }

    getSelectable() {
        return this.#selectable;
    }

    addDestination(latlng: L.LatLng) {
        var path: any = {};
        if (this.getTaskData().activePath != undefined) {
            path = this.getTaskData().activePath;
            path[(Object.keys(path).length + 1).toString()] = latlng;
        }
        else {
            path = { "1": latlng };
        }
        addDestination(this.ID, path);
    }

    clearDestinations() {
        this.getTaskData().activePath = undefined;
    }

    updateVisibility()
    {
        this.setHidden( document.body.getAttribute(`data-hide-${this.getMissionData().coalition}`) != null || 
                        document.body.getAttribute(`data-hide-${this.getMarkerCategory()}`) != null ||
                        !this.getBaseData().alive)
    }

    setHidden(hidden: boolean)
    {
        this.#hidden = hidden; 

        /* Add the marker if not present */
        if (!getMap().hasLayer(this) && !this.getHidden()) {
            this.addTo(getMap());
        }

        /* Hide the marker if necessary*/
        if (getMap().hasLayer(this) && this.getHidden()) {
            getMap().removeLayer(this);
        }        
    }

    getHidden() {
        return this.#hidden;
    }

    getLeader() {
        return getUnitsManager().getUnitByID(this.getFormationData().leaderID);
    }

    attackUnit(targetID: number) {
        /* Units can't attack themselves */
        if (this.ID != targetID) {
            attackUnit(this.ID, targetID);
        }
    }

    followUnit(targetID: number, offset: {"x": number, "y": number, "z": number}) {
        /* Units can't follow themselves */
        if (this.ID != targetID) {
            followUnit(this.ID, targetID, offset);
        }
    }

    landAt(latlng: LatLng) {
        landAt(this.ID, latlng);
    }

    changeSpeed(speedChange: string) {
        changeSpeed(this.ID, speedChange);
    }

    changeAltitude(altitudeChange: string) {
        changeAltitude(this.ID, altitudeChange);
    }

    setSpeed(speed: number) {
        setSpeed(this.ID, speed);
    }

    setAltitude(altitude: number) {
        setAltitude(this.ID, altitude);
    }

    setROE(ROE: string) {
        setROE(this.ID, ROE);
    }

    setReactionToThreat(reactionToThreat: string) {
        setReactionToThreat(this.ID, reactionToThreat);
    }

    setLeader(isLeader: boolean, wingmenIDs: number[] = []) {
        setLeader(this.ID, isLeader, wingmenIDs);
    }

    delete() {
        deleteUnit(this.ID);
    }

    refuel() {
        refuel(this.ID);
    }

    setAdvancedOptions(isTanker: boolean, isAWACS: boolean, TACANChannel: number, TACANXY: string, TACANcallsign: string, radioFrequency: number, radioCallsign: number, radioCallsignNumber: number) {
        setAdvacedOptions(this.ID, isTanker, isAWACS, TACANChannel, TACANXY, TACANcallsign, radioFrequency, radioCallsign, radioCallsignNumber);
    }

    #onClick(e: any) {
        this.#timer = window.setTimeout(() => {
            if (!this.#preventClick) {
                if (getMap().getState() === 'IDLE' || getMap().getState() === 'MOVE_UNIT' || e.originalEvent.ctrlKey) {
                    if (!e.originalEvent.ctrlKey) {
                        getUnitsManager().deselectAllUnits();
                    }
                    this.setSelected(!this.getSelected());
                }
            }
            this.#preventClick = false;
        }, 200);
    }

    #onDoubleClick(e: any) {
        clearTimeout(this.#timer);
        this.#preventClick = true;
    }

    #onContextMenu(e: any) {
        var options: {[key: string]: string} = {};

        options["Center"] = `<div id="center-map">Center map</div>`; 

        if (getUnitsManager().getSelectedUnits().length > 0 && !(getUnitsManager().getSelectedUnits().length == 1 && (getUnitsManager().getSelectedUnits().includes(this))))
        {
            options['Attack'] = `<div id="attack">Attack</div>`;
            if (getUnitsManager().getSelectedUnitsType() === "Aircraft")
                options['Follow'] = `<div id="follow">Follow</div>`;
        }
        else if ((getUnitsManager().getSelectedUnits().length > 0 && (getUnitsManager().getSelectedUnits().includes(this))) || getUnitsManager().getSelectedUnits().length == 0)
        {
            if (this.getBaseData().category == "Aircraft")
            {
                options["Refuel"] = `<div id="refuel">Refuel</div>`; // TODO Add some way of knowing which aircraft can AAR
            }
        }

        if (Object.keys(options).length > 0)
        {
            getMap().showUnitContextMenu(e);
            getMap().getUnitContextMenu().setOptions(options, (option: string) => {
                getMap().hideUnitContextMenu();
                this.#executeAction(e, option);
            });
        }
    }

    #executeAction(e: any, action: string) {
        if (action === "Center")
            getMap().centerOnUnit(this.ID);
        if (action === "Attack")
            getUnitsManager().selectedUnitsAttackUnit(this.ID);
        else if (action === "Refuel")
            getUnitsManager().selectedUnitsRefuel();
        else if (action === "Follow")
            this.#showFollowOptions(e);
    }

    #showFollowOptions(e: any) {
        var options: {[key: string]: string} = {};

        options = {
            'Trail': `<div id="trail">Trail</div>`,
            'Echelon (LH)': `<div id="echelon-lh">Echelon (left)</div>`,
            'Echelon (RH)': `<div id="echelon-rh">Echelon (right)</div>`,
            'Line abreast (LH)': `<div id="line-abreast">Line abreast (left)</div>`,
            'Line abreast (RH)': `<div id="line-abreast">Line abreast (right)</div>`,
            'Front': `<div id="front">In front</div>`,
            'Custom': `<div id="custom">Custom</div>`
        }

        getMap().getUnitContextMenu().setOptions(options, (option: string) => {
            getMap().hideUnitContextMenu();
            this.#applyFollowOptions(option);
        });
        getMap().showUnitContextMenu(e);
    }

    #applyFollowOptions(action: string)
    {
        if (action === "Custom")
        {
            document.getElementById("custom-formation-dialog")?.classList.remove("hide");
            getMap().getUnitContextMenu().setCustomFormationCallback((offset: {x: number, y: number, z: number}) => {
                getUnitsManager().selectedUnitsFollowUnit(this.ID, offset);
            })
        }
        else {
            // X: front-rear, positive front
            // Y: top-bottom, positive top
            // Z: left-right, positive right

            var offset = {"x": 0, "y": 0, "z": 0};
            if (action == "Trail")                  { offset.x = -50; offset.y = -30; offset.z = 0; }
            else if (action == "Echelon (LH)")      { offset.x = -50; offset.y = -10; offset.z = -50; }
            else if (action == "Echelon (RH)")      { offset.x = -50; offset.y = -10; offset.z = 50; }
            else if (action == "Line abreast (RH)") { offset.x = 0; offset.y = 0; offset.z = 50; }
            else if (action == "Line abreast (LH)") { offset.x = 0; offset.y = 0; offset.z = -50; }
            else if (action == "Front")             { offset.x = 100; offset.y = 0; offset.z = 0; }
            getUnitsManager().selectedUnitsFollowUnit(this.ID, offset);
        }
    }

    #updateMarker() {
        this.updateVisibility();

        /* Draw the minimap marker */
        if (this.getBaseData().alive )
        {
            if (this.#miniMapMarker == null)
            {
                this.#miniMapMarker = new CircleMarker(new LatLng(this.getFlightData().latitude, this.getFlightData().longitude), {radius: 0.5});
                if (this.getMissionData().coalition == "neutral")
                    this.#miniMapMarker.setStyle({color: "#CFD9E8"});
                else if (this.getMissionData().coalition == "red")
                    this.#miniMapMarker.setStyle({color: "#ff5858"});
                else 
                    this.#miniMapMarker.setStyle({color: "#247be2"});
                this.#miniMapMarker.addTo(getMap().getMiniMapLayerGroup());
                this.#miniMapMarker.bringToBack();
            }
            else {
                this.#miniMapMarker.setLatLng(new LatLng(this.getFlightData().latitude, this.getFlightData().longitude));
                this.#miniMapMarker.bringToBack();
            }
        }
        else {
            if (this.#miniMapMarker != null && getMap().getMiniMapLayerGroup().hasLayer(this.#miniMapMarker)) {
                getMap().getMiniMapLayerGroup().removeLayer(this.#miniMapMarker);
                this.#miniMapMarker = null;
            }
        }

        /* Draw the marker */
        if (!this.getHidden()) {
            this.setLatLng(new LatLng(this.getFlightData().latitude, this.getFlightData().longitude));

            var element = this.getElement();
            if (element != null) {
                /* Draw the velocity vector */
                element.querySelector(".unit-vvi")?.setAttribute("style", `height: ${15 + this.getFlightData().speed / 5}px;`);

                /* Set fuel data */
                element.querySelector(".unit-fuel-level")?.setAttribute("style", `width: ${this.getMissionData().fuel}%`);
                element.querySelector(".unit")?.toggleAttribute("data-has-low-fuel", this.getMissionData().fuel < 20);

                /* Set dead/alive flag */
                element.querySelector(".unit")?.toggleAttribute("data-is-dead", !this.getBaseData().alive);

                /* Set current unit state */
                if (this.getMissionData().flags.Human)  // Unit is human
                    element.querySelector(".unit")?.setAttribute("data-state", "human");
                else if (!this.getBaseData().AI)        // Unit is under DCS control (not Olympus)
                    element.querySelector(".unit")?.setAttribute("data-state", "dcs");
                else                                    // Unit is under Olympus control
                    element.querySelector(".unit")?.setAttribute("data-state", this.getTaskData().currentState.toLowerCase());

                /* Set altitude and speed */
                if (element.querySelector(".unit-altitude"))
                    (<HTMLElement> element.querySelector(".unit-altitude")).innerText = "FL" + String(Math.floor(this.getFlightData().altitude / 0.3048 / 1000));
                if (element.querySelector(".unit-speed"))
                    (<HTMLElement> element.querySelector(".unit-speed")).innerHTML = String(Math.floor(this.getFlightData().speed * 1.94384 ) );
                
                /* Rotate elements according to heading */
                element.querySelectorAll( "[data-rotate-to-heading]" ).forEach( el => {
                    const headingDeg = rad2deg( this.getFlightData().heading );
                    let currentStyle = el.getAttribute( "style" ) || "";
                    el.setAttribute( "style", currentStyle + `transform:rotate(${headingDeg}deg);` );
                });
            }
            /* Set vertical offset for altitude stacking */
            var pos = getMap().latLngToLayerPoint(this.getLatLng()).round();
            this.setZIndexOffset(1000 + Math.floor(this.getFlightData().altitude) - pos.y + (this.#hovered || this.#selected? 5000: 0));
        }
    }

    #drawPath() {
        if (this.getTaskData().activePath != undefined) {
            var points = [];
            points.push(new LatLng(this.getFlightData().latitude, this.getFlightData().longitude));

            /* Add markers if missing */
            while (this.#pathMarkers.length < Object.keys(this.getTaskData().activePath).length) {
                var marker = new Marker([0, 0], { icon: pathIcon }).addTo(getMap());
                this.#pathMarkers.push(marker);
            }

            /* Remove markers if too many */
            while (this.#pathMarkers.length > Object.keys(this.getTaskData().activePath).length) {
                getMap().removeLayer(this.#pathMarkers[this.#pathMarkers.length - 1]);
                this.#pathMarkers.splice(this.#pathMarkers.length - 1, 1)
            }

            /* Update the position of the existing markers (to avoid creating markers uselessly) */
            for (let WP in this.getTaskData().activePath) {
                var destination = this.getTaskData().activePath[WP];
                this.#pathMarkers[parseInt(WP) - 1].setLatLng([destination.lat, destination.lng]);
                points.push(new LatLng(destination.lat, destination.lng));
                this.#pathPolyline.setLatLngs(points);
            }

            if (points.length == 1)
                this.#clearPath();
        }
    }

    #clearPath() {
        for (let WP in this.#pathMarkers) {
            getMap().removeLayer(this.#pathMarkers[WP]);
        }
        this.#pathMarkers = [];
        this.#pathPolyline.setLatLngs([]);
    }

    #drawTargets() {
        for (let typeIndex in this.getMissionData().targets) {
            for (let index in this.getMissionData().targets[typeIndex]) {
                var targetData = this.getMissionData().targets[typeIndex][index];
                var target = getUnitsManager().getUnitByID(targetData.object["id_"])
                if (target != null) {
                    var startLatLng = new LatLng(this.getFlightData().latitude, this.getFlightData().longitude)
                    var endLatLng = new LatLng(target.getFlightData().latitude, target.getFlightData().longitude)

                    var color;
                    if (typeIndex === "radar")
                        color = "#FFFF00";
                    else if (typeIndex === "visual")
                        color = "#FF00FF";
                    else if (typeIndex === "rwr")
                        color = "#00FF00";
                    else
                        color = "#FFFFFF";
                    var targetPolyline = new Polyline([startLatLng, endLatLng], { color: color, weight: 3, opacity: 0.4, smoothFactor: 1 });
                    targetPolyline.addTo(getMap());
                    this.#targetsPolylines.push(targetPolyline)
                }
            }
        }
    }

    #clearTargets() {
        for (let index in this.#targetsPolylines) {
            getMap().removeLayer(this.#targetsPolylines[index])
        }
    }
}

export class AirUnit extends Unit {

}

export class Aircraft extends AirUnit {
    constructor(ID: number, data: UnitData) {
        super(ID, data);
    }

    getMarkerHTML()
    {
        return `<div class="unit" data-object="unit-aircraft" data-coalition="${this.getMissionData().coalition}">
                    <div class="unit-selected-spotlight"></div>
                    <div class="unit-marker-border"></div>
                    <div class="unit-state"></div>
                    <div class="unit-vvi" data-rotate-to-heading></div>
                    <div class="unit-hotgroup">
                        <div class="unit-hotgroup-id"></div>
                    </div>
                    <div class="unit-marker"></div>
                    <div class="unit-short-label">${aircraftDatabase.getByName(this.getBaseData().name)?.shortLabel || ""}</div>
                    <div class="unit-fuel">
                        <div class="unit-fuel-level" style="width:100%;"></div>
                    </div>
                    <div class="unit-ammo">
                        <div class="unit-ammo-fox-1"></div>
                        <div class="unit-ammo-fox-2"></div>
                        <div class="unit-ammo-fox-3"></div>
                        <div class="unit-ammo-other"></div>
                    </div>
                    <div class="unit-summary">
                        <div class="unit-callsign">${this.getBaseData().unitName}</div>
                        <div class="unit-altitude"></div>
                        <div class="unit-speed"></div>
                    </div>
                </div>`
    }

    getMarkerCategory()
    {
        return "aircraft";
    }
}

export class Helicopter extends AirUnit {
    constructor(ID: number, data: UnitData) {
        super(ID, data);
    }

    getVisibilityCategory()
    {
        return "helicopter";
    }
}

export class GroundUnit extends Unit {
    constructor(ID: number, data: UnitData) {
        super(ID, data);
    }

    getMarkerHTML() {
        var role = groundUnitsDatabase.getByName(this.getBaseData().name)?.loadouts[0].roles[0];
        return  `<div class="unit" data-object="unit-${this.getMarkerCategory()}" data-coalition="${this.getMissionData().coalition}">
                    <div class="unit-selected-spotlight"></div>
                    <div class="unit-marker"></div>
                    <div class="unit-short-label">${role?.substring(0, 1)?.toUpperCase() || ""}</div>
                </div>`
    }

    getMarkerCategory()
    {
        // TODO this is very messy
        var role = groundUnitsDatabase.getByName(this.getBaseData().name)?.loadouts[0].roles[0];
        var markerCategory = (role === "SAM") ? "sam" : "groundunit";
        return markerCategory;
    }
}

export class NavyUnit extends Unit {
    constructor(ID: number, data: UnitData) {
        super(ID, data);
    }
    
    getMarkerCategory() {
        return "navyunit";
    }
}

export class Weapon extends Unit {
    constructor(ID: number, data: UnitData) {
        super(ID, data);
        this.setSelectable(false);
    }

    getMarkerHTML(): string {
        return `<div class="unit" data-object="unit-${this.getMarkerCategory()}" data-coalition="${this.getMissionData().coalition}">
                    <div class="unit-selected-spotlight"></div>
                    <div class="unit-marker" data-rotate-to-heading></div>
                    <div class="unit-short-label"></div>
                </div>`
    }

}

export class Missile extends Weapon {
    constructor(ID: number, data: UnitData) {
        super(ID, data);
    }

    getMarkerCategory() {
        return "missile";
    }
}

export class Bomb extends Weapon {
    constructor(ID: number, data: UnitData) {
        super(ID, data);
    }

    getMarkerCategory() {
        return "bomb";
    }
}
