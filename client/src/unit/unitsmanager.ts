import { LatLng, LatLngBounds } from "leaflet";
import { getApp } from "..";
import { Unit } from "./unit";
import { bearingAndDistanceToLatLng, deg2rad, getGroundElevation, getUnitDatabaseByCategory, keyEventWasInInput, latLngToMercator, mToFt, mercatorToLatLng, msToKnots, polyContains, polygonArea, randomPointInPoly, randomUnitBlueprint } from "../other/utils";
import { CoalitionArea } from "../map/coalitionarea/coalitionarea";
import { groundUnitDatabase } from "./databases/groundunitdatabase";
import { DELETE_CYCLE_TIME, DELETE_SLOW_THRESHOLD, DataIndexes, GAME_MASTER, IADSDensities, IDLE, MOVE_UNIT } from "../constants/constants";
import { DataExtractor } from "../server/dataextractor";
import { citiesDatabase } from "./databases/citiesdatabase";
import { aircraftDatabase } from "./databases/aircraftdatabase";
import { helicopterDatabase } from "./databases/helicopterdatabase";
import { navyUnitDatabase } from "./databases/navyunitdatabase";
import { TemporaryUnitMarker } from "../map/markers/temporaryunitmarker";
import { Popup } from "../popups/popup";
import { HotgroupPanel } from "../panels/hotgrouppanel";
import { Contact, UnitBlueprint, UnitData, UnitSpawnTable } from "../interfaces";
import { Dialog } from "../dialog/dialog";
import { Group } from "./group";
import { UnitDataFileExport } from "./importexport/unitdatafileexport";
import { UnitDataFileImport } from "./importexport/unitdatafileimport";

/** The UnitsManager handles the creation, update, and control of units. Data is strictly updated by the server ONLY. This means that any interaction from the user will always and only
 * result in a command to the server, executed by means of a REST PUT request. Any subsequent change in data will be reflected only when the new data is sent back by the server. This strategy allows
 * to avoid client/server and client/client inconsistencies.
 */
export class UnitsManager {
    #copiedUnits: UnitData[];
    #deselectionEventDisabled: boolean = false;
    #requestDetectionUpdate: boolean = false;
    #selectionEventDisabled: boolean = false;
    #slowDeleteDialog!: Dialog;
    #units: { [ID: number]: Unit };
    #groups: { [groupName: string]: Group } = {};
    #unitDataExport!: UnitDataFileExport;
    #unitDataImport!: UnitDataFileImport;

    constructor() {
        this.#copiedUnits = [];
        this.#units = {};

        document.addEventListener('commandModeOptionsChanged', () => { Object.values(this.#units).forEach((unit: Unit) => unit.updateVisibility()) });
        document.addEventListener('contactsUpdated', (e: CustomEvent) => { this.#requestDetectionUpdate = true });
        document.addEventListener('copy', () => this.copy());
        document.addEventListener('deleteSelectedUnits', () => this.delete());
        document.addEventListener('explodeSelectedUnits', (e: any) => this.delete(true, e.detail.type));
        document.addEventListener('exportToFile', () => this.exportToFile());
        document.addEventListener('importFromFile', () => this.importFromFile());
        document.addEventListener('keyup', (event) => this.#onKeyUp(event));
        document.addEventListener('paste', () => this.paste());
        document.addEventListener('selectedUnitsChangeAltitude', (e: any) => { this.changeAltitude(e.detail.type) });
        document.addEventListener('selectedUnitsChangeSpeed', (e: any) => { this.changeSpeed(e.detail.type) });
        document.addEventListener('unitDeselection', (e: CustomEvent) => this.#onUnitDeselection(e.detail));
        document.addEventListener('unitSelection', (e: CustomEvent) => this.#onUnitSelection(e.detail));
        document.addEventListener("toggleMarkerProtection", (ev: CustomEventInit) => { this.#showNumberOfSelectedProtectedUnits() });

        this.#slowDeleteDialog = new Dialog("slow-delete-dialog");
    }

    /**
     * 
     * @returns All the existing units, both alive and dead
     */
    getUnits() {
        return this.#units;
    }

    /** Get a specific unit by ID
     * 
     * @param ID ID of the unit. The ID shall be the same as the unit ID in DCS.
     * @returns Unit object, or null if no unit with said ID exists.
     */
    getUnitByID(ID: number) {
        if (ID in this.#units)
            return this.#units[ID];
        else
            return null;
    }

    /** Returns all the units that belong to a hotgroup
     * 
     * @param hotgroup Hotgroup number
     * @returns Array of units that belong to hotgroup
     */
    getUnitsByHotgroup(hotgroup: number) {
        return Object.values(this.#units).filter((unit: Unit) => { return unit.getAlive() && unit.getHotgroup() == hotgroup });
    }

    /** Add a new unit to the manager
     * 
     * @param ID ID of the new unit
     * @param category Either "Aircraft", "Helicopter", "GroundUnit", or "NavyUnit". Determines what class will be used to create the new unit accordingly.
     */
    addUnit(ID: number, category: string) {
        if (category) {
            /* Get the constructor from the unit category */
            var constructor = Unit.getConstructor(category);
            if (constructor != undefined) {
                this.#units[ID] = new constructor(ID);
            }
        }
    }

    /** Sort units segregated groups based on controlling type and protection, if DCS-controlled
     * 
     * @param units <Unit[]>
     * @returns Object
     */
    segregateUnits(units: Unit[]): { [key: string]: [] } {
        const data: any = {
            controllable: [],
            dcsProtected: [],
            dcsUnprotected: [],
            human: [],
            olympus: []
        };
        const map = getApp().getMap();

        units.forEach(unit => {
            if (unit.getHuman())
                data.human.push(unit);
            else if (unit.isControlledByOlympus())
                data.olympus.push(unit);
            else if (map.getIsUnitProtected(unit))
                data.dcsProtected.push(unit);
            else
                data.dcsUnprotected.push(unit);
        });
        data.controllable = [].concat(data.dcsUnprotected, data.human, data.olympus);
        return data;
    }

    /**
     * 
     * @param numOfProtectedUnits number
     */
    showProtectedUnitsPopup(numOfProtectedUnits: number) {
        if (numOfProtectedUnits < 1)
            return;
        const messageText = (numOfProtectedUnits === 1) ? `Unit is protected` : `All selected units are protected`;
        (getApp().getPopupsManager().get("infoPopup") as Popup).setText(messageText);
        //  Cheap way for now until we use more locks
        let lock = <HTMLElement>document.querySelector("#unit-visibility-control button.lock");
        lock.classList.add("prompt");
        setTimeout(() => lock.classList.remove("prompt"), 4000);
    }

    /** Update the data of all the units. The data is directly decoded from the binary buffer received from the REST Server. This is necessary for performance and bandwidth reasons.
     * 
     * @param buffer The arraybuffer, encoded according to the ICD defined in: TODO Add reference to ICD
     * @returns The decoded updateTime of the data update.
     */
    update(buffer: ArrayBuffer) {
        /* Extract the data from the arraybuffer. Since data is encoded dynamically (not all data is always present, but rather only the data that was actually updated since the last request).
        No a prori casting can be performed. On the contrary, the array is decoded incrementally, depending on the DataIndexes of the data. The actual data decoding is performed by the Unit class directly. 
        Every time a piece of data is decoded the decoder seeker is incremented. */
        var dataExtractor = new DataExtractor(buffer);

        var updateTime = Number(dataExtractor.extractUInt64());

        /* Run until all data is extracted or an error occurs */
        while (dataExtractor.getSeekPosition() < buffer.byteLength) {
            /* Extract the unit ID */
            const ID = dataExtractor.extractUInt32();

            /* If the ID of the unit does not yet exist, create the unit, if the category is known. If it isn't, some data must have been lost and we need to wait for another update */
            if (!(ID in this.#units)) {
                const datumIndex = dataExtractor.extractUInt8();
                if (datumIndex == DataIndexes.category) {
                    const category = dataExtractor.extractString();
                    this.addUnit(ID, category);
                }
                else {
                    /* Inconsistent data, we need to wait for a refresh */
                    return updateTime;
                }
            }
            /* Update the data of the unit */
            this.#units[ID]?.setData(dataExtractor);
        }

        /* Update the unit groups */
        for (let ID in this.#units) {
            const unit = this.#units[ID];
            const groupName = unit.getGroupName();

            if (groupName !== "") {
                /* If the group does not yet exist, create it */
                if (!(groupName in this.#groups))
                    this.#groups[groupName] = new Group(groupName);

                /* If the unit was not assigned to a group yet, assign it */
                if (unit.getGroup() === null)
                    this.#groups[groupName].addMember(unit);
            }
        }

        /* If we are not in Game Master mode, visibility of units by the user is determined by the detections of the units themselves. This is performed here.
        This operation is computationally expensive, therefore it is only performed when #requestDetectionUpdate is true. This happens whenever a change in the detectionUpdates is detected 
        */
        if (this.#requestDetectionUpdate && getApp().getMissionManager().getCommandModeOptions().commandMode != GAME_MASTER) {
            /* Create a dictionary of empty detection methods arrays */
            var detectionMethods: { [key: string]: number[] } = {};
            for (let ID in this.#units)
                detectionMethods[ID] = [];
            for (let ID in getApp().getWeaponsManager().getWeapons())
                detectionMethods[ID] = [];

            /* Fill the array with the detection methods */
            for (let ID in this.#units) {
                const unit = this.#units[ID];
                if (unit.getAlive() && unit.belongsToCommandedCoalition()) {
                    const contacts = unit.getContacts();
                    contacts.forEach((contact: Contact) => {
                        const contactID = contact.ID;
                        if (contactID in detectionMethods && !(detectionMethods[contactID].includes(contact.detectionMethod)))
                            detectionMethods[contactID]?.push(contact.detectionMethod);
                    })
                }
            }

            /* Set the detection methods for every unit */
            for (let ID in this.#units) {
                const unit = this.#units[ID];
                unit?.setDetectionMethods(detectionMethods[ID]);
            }

            /* Set the detection methods for every weapon (weapons must be detected too) */
            for (let ID in getApp().getWeaponsManager().getWeapons()) {
                const weapon = getApp().getWeaponsManager().getWeaponByID(parseInt(ID));
                weapon?.setDetectionMethods(detectionMethods[ID]);
            }

            this.#requestDetectionUpdate = false;
        }

        /* Update the detection lines of all the units. This code is handled by the UnitsManager since it must be run both when the detected OR the detecting unit is updated */
        for (let ID in this.#units) {
            if (this.#units[ID].getSelected())
                this.#units[ID].drawLines();
        };

        return updateTime;
    }

    /** Set a unit as "selected", which will allow to perform operations on it, like giving it a destination, setting it to attack a target, and so on
     * 
     * @param ID The ID of the unit to select
     * @param deselectAllUnits If true, the unit will be the only selected unit
     */
    selectUnit(ID: number, deselectAllUnits: boolean = true) {
        if (deselectAllUnits)
            this.getSelectedUnits().filter((unit: Unit) => unit.ID !== ID).forEach((unit: Unit) => unit.setSelected(false));
        this.#units[ID]?.setSelected(true);
    }

    /** Select all visible units inside a bounding rectangle
     * 
     * @param bounds Leaflet bounds object defining the selection area
     */
    selectFromBounds(bounds: LatLngBounds) {
        this.deselectAllUnits();
        for (let ID in this.#units) {
            if (this.#units[ID].getHidden() == false) {
                var latlng = new LatLng(this.#units[ID].getPosition().lat, this.#units[ID].getPosition().lng);
                if (bounds.contains(latlng)) {
                    this.#units[ID].setSelected(true);
                }
            }
        }
    }

    /** Select units by hotgroup. A hotgroup can be created to quickly select multiple units using keyboard bindings
     * 
     * @param hotgroup The hotgroup number
     */
    selectUnitsByHotgroup(hotgroup: number, deselectAllUnits: boolean = true) {

        if (deselectAllUnits) {
            this.deselectAllUnits();
        }

        this.getUnitsByHotgroup(hotgroup).forEach((unit: Unit) => unit.setSelected(true))
    }

    /** Get all the currently selected units
     * 
     * @param options Selection options
     * @returns Array of selected units
     */
    getSelectedUnits(options?: { excludeHumans?: boolean, excludeProtected?: boolean, onlyOnePerGroup?: boolean, showProtectionReminder?: boolean }) {
        let selectedUnits: Unit[] = [];
        let numProtectedUnits = 0;
        for (const [ID, unit] of Object.entries(this.#units)) {
            if (unit.getSelected()) {
                if (options) {
                    if (options.excludeHumans && unit.getHuman())
                        continue

                    if (options.excludeProtected === true && this.#unitIsProtected(unit)) {
                        numProtectedUnits++;
                        continue;
                    }
                }
                selectedUnits.push(unit);
            }
        }
        if (options) {
            if (options.showProtectionReminder === true && numProtectedUnits > selectedUnits.length && selectedUnits.length === 0)
                this.showProtectedUnitsPopup(numProtectedUnits);

            if (options.onlyOnePerGroup) {
                var temp: Unit[] = [];
                for (let unit of selectedUnits) {
                    if (!temp.some((otherUnit: Unit) => unit.getGroupName() == otherUnit.getGroupName()))
                        temp.push(unit);
                }
                selectedUnits = temp;
            }
        }
        return selectedUnits;
    }

    /** Deselects all currently selected units
     * 
     */
    deselectAllUnits() {
        for (let ID in this.#units) {
            this.#units[ID].setSelected(false);
        }
    }

    /** Deselect a specific unit
     * 
     * @param ID ID of the unit to deselect
     */
    deselectUnit(ID: number) {
        this.#units[ID]?.setSelected(false);
    }

    /** This function allows to quickly determine the categories (Aircraft, Helicopter, GroundUnit, NavyUnit) of an array units. This allows to enable/disable specific controls which can only be applied
     * to specific categories.
     * 
     * @param units Array of units of which to retrieve the categories
     * @returns Array of categories. Each category is present only once.
     */
    getUnitsCategories(units: Unit[]) {
        if (units.length == 0)
            return [];
        return units.map((unit: Unit) => {
            return unit.getCategory();
        })?.filter((value: any, index: number, array: string[]) => {
            return array.indexOf(value) === index;
        });
    }

    /**  This function returns the value of a variable for each of the units in the input array. If all the units have the same value, returns the value, else returns undefined. This function is useful to 
     * present units data in the control panel, which will print a specific value only if it is the same for all the units. If the values are different, the control panel will show a "mixed values" value, or similar. 
     * 
     * @param variableGetter CallableFunction that returns the requested variable. Example: getUnitsVariable((unit: Unit) => unit.getName(), foo) will return a string value if all the units have the same name, otherwise it will return undefined.
     * @param units Array of units of which to retrieve the variable
     * @returns The value of the variable if all units have the same value, else undefined
     */
    getUnitsVariable(variableGetter: CallableFunction, units: Unit[]) {
        if (units.length == 0)
            return undefined;

        var value: any = variableGetter(units[0]);
        units.forEach((unit: Unit) => {
            if (variableGetter(unit) !== value)
                value = undefined;
        });
        return value;
    };

    /** For a given unit, it returns if and how it is being detected by other units. NOTE: this function will return how a unit is being detected, i.e. how other units are detecting it. It will not return
     * what the unit is detecting.
     * 
     * @param unit The unit of which to retrieve the "detected" methods.
     * @returns Array of detection methods
     */
    getUnitDetectedMethods(unit: Unit) {
        var detectionMethods: number[] = [];
        for (let idx in this.#units) {
            if (this.#units[idx].getAlive() && this.#units[idx].getIsLeader() && this.#units[idx].getCoalition() !== "neutral" && this.#units[idx].getCoalition() != unit.getCoalition()) {
                this.#units[idx].getContacts().forEach((contact: Contact) => {
                    if (contact.ID == unit.ID && !detectionMethods.includes(contact.detectionMethod))
                        detectionMethods.push(contact.detectionMethod);
                });
            }
        }
        return detectionMethods;
    }

    /*********************** Unit actions on selected units ************************/
    /** Give a new destination to the selected units
     * 
     * @param latlng Position of the new destination
     * @param mantainRelativePosition If true, the selected units will mantain their relative positions when reaching the target. This is useful to maintain a formation for groun/navy units
     * @param rotation Rotation in radians by which the formation will be rigidly rotated. E.g. a ( V ) formation will look like this ( < ) if rotated pi/4 radians (90 degrees)
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    addDestination(latlng: L.LatLng, mantainRelativePosition: boolean, rotation: number, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        /* Compute the destination for each unit. If mantainRelativePosition is true, compute the destination so to hold the relative positions */
        var unitDestinations: { [key: number]: LatLng } = {};
        if (mantainRelativePosition)
            unitDestinations = this.computeGroupDestination(latlng, rotation);
        else
            units.forEach((unit: Unit) => { unitDestinations[unit.ID] = latlng; });

        units.forEach((unit: Unit) => {
            /* If a unit is following another unit, and that unit is also selected, send the command to the followed ("leader") unit */
            if (unit.getState() === "follow") {
                const leader = this.getUnitByID(unit.getLeaderID())
                if (leader && leader.getSelected())
                    leader.addDestination(latlng);
                else
                    unit.addDestination(latlng);
            }
            else {
                if (unit.ID in unitDestinations)
                    unit.addDestination(unitDestinations[unit.ID]);
            }
        });
        this.#showActionMessage(units, " new destination added");
    }

    /** Clear the destinations of all the selected units
     * 
     */
    clearDestinations(units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: false });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        for (let idx in units) {
            const unit = units[idx];
            if (unit.getState() === "follow") {
                const leader = this.getUnitByID(unit.getLeaderID())
                if (leader && leader.getSelected())
                    leader.clearDestinations();
                else
                    unit.clearDestinations();
            }
            else
                unit.clearDestinations();
        }
    }

    /** Instruct all the selected units to land at a specific location
     * 
     * @param latlng Location where to land at
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    landAt(latlng: LatLng, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.landAt(latlng));

        this.#showActionMessage(units, " landing");
    }

    /** Instruct all the selected units to change their speed
     * 
     * @param speedChange Speed change, either "stop", "slow", or "fast". The specific value depends on the unit category
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    changeSpeed(speedChange: string, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.changeSpeed(speedChange));
    }

    /** Instruct all the selected units to change their altitude
     * 
     * @param altitudeChange Altitude change, either "climb" or "descend". The specific value depends on the unit category
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    changeAltitude(altitudeChange: string, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.changeAltitude(altitudeChange));
    }

    /** Set a specific speed to all the selected units
     * 
     * @param speed Value to set, in m/s
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    setSpeed(speed: number, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.setSpeed(speed));
        this.#showActionMessage(units, `setting speed to ${msToKnots(speed)} kts`);
    }

    /** Set a specific speed type to all the selected units
     * 
     * @param speedType Value to set, either "CAS" or "GS". If "CAS" is selected, the unit will try to maintain the selected Calibrated Air Speed, but DCS will still only maintain a Ground Speed value so errors may arise depending on wind.
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    setSpeedType(speedType: string, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.setSpeedType(speedType));
        this.#showActionMessage(units, `setting speed type to ${speedType}`);
    }

    /** Set a specific altitude to all the selected units
     * 
     * @param altitude Value to set, in m
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    setAltitude(altitude: number, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.setAltitude(altitude));
        this.#showActionMessage(units, `setting altitude to ${mToFt(altitude)} ft`);
    }

    /** Set a specific altitude type to all the selected units
     * 
     * @param altitudeType Value to set, either "ASL" or "AGL". If "AGL" is selected, the unit will try to maintain the selected Above Ground Level altitude. Due to a DCS bug, this will only be true at the final position.
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    setAltitudeType(altitudeType: string, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.setAltitudeType(altitudeType));
        this.#showActionMessage(units, `setting altitude type to ${altitudeType}`);
    }

    /** Set a specific ROE to all the selected units
     * 
     * @param ROE Value to set, see constants for acceptable values
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    setROE(ROE: string, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.setROE(ROE));
        this.#showActionMessage(units, `ROE set to ${ROE}`);
    }

    /** Set a specific reaction to threat to all the selected units
     * 
     * @param reactionToThreat Value to set, see constants for acceptable values
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    setReactionToThreat(reactionToThreat: string, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.setReactionToThreat(reactionToThreat));
        this.#showActionMessage(units, `reaction to threat set to ${reactionToThreat}`);
    }

    /** Set a specific emissions & countermeasures to all the selected units
     * 
     * @param emissionCountermeasure Value to set, see constants for acceptable values
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    setEmissionsCountermeasures(emissionCountermeasure: string, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.setEmissionsCountermeasures(emissionCountermeasure));
        this.#showActionMessage(units, `emissions & countermeasures set to ${emissionCountermeasure}`);
    }

    /** Turn selected units on or off, only works on ground and navy units
     * 
     * @param onOff If true, the unit will be turned on
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    setOnOff(onOff: boolean, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.setOnOff(onOff));
        this.#showActionMessage(units, `unit active set to ${onOff}`);
    }

    /** Instruct the selected units to follow roads, only works on ground units
     * 
     * @param followRoads If true, units will follow roads
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    setFollowRoads(followRoads: boolean, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.setFollowRoads(followRoads));
        this.#showActionMessage(units, `follow roads set to ${followRoads}`);
    }

    /** Instruct selected units to operate as a certain coalition
     * 
     * @param operateAsBool If true, units will operate as blue
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    setOperateAs(operateAsBool: boolean, units: Unit[] | null = null) {
        var operateAs = operateAsBool ? "blue" : "red";
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.setOperateAs(operateAs));
        this.#showActionMessage(units, `operate as set to ${operateAs}`);
    }

    /** Instruct units to attack a specific unit
     * 
     * @param ID ID of the unit to attack
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    attackUnit(ID: number, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.attackUnit(ID));
        this.#showActionMessage(units, `attacking unit ${this.getUnitByID(ID)?.getUnitName()}`);
    }

    /** Instruct units to refuel at the nearest tanker, if possible. Else units will RTB
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    refuel(units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        segregatedUnits.controllable.forEach((unit: Unit) => unit.refuel());
        this.#showActionMessage(segregatedUnits.controllable, `sent to nearest tanker`);
    }

    /** Instruct the selected units to follow another unit in a formation. Only works for aircrafts and helicopters.
     * 
     * @param ID ID of the unit to follow
     * @param offset Optional parameter, defines a static offset. X: front-rear, positive front, Y: top-bottom, positive top, Z: left-right, positive right
     * @param formation Optional parameter, defines a predefined formation type. Values are: "trail", "echelon-lh", "echelon-rh", "line-abreast-lh", "line-abreast-rh", "front", "diamond"
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    followUnit(ID: number, offset?: { "x": number, "y": number, "z": number }, formation?: string, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        if (offset == undefined) {
            /* Simple formations with fixed offsets */
            offset = { "x": 0, "y": 0, "z": 0 };
            if (formation === "trail") { offset.x = -50; offset.y = -30; offset.z = 0; }
            else if (formation === "echelon-lh") { offset.x = -50; offset.y = -10; offset.z = -50; }
            else if (formation === "echelon-rh") { offset.x = -50; offset.y = -10; offset.z = 50; }
            else if (formation === "line-abreast-lh") { offset.x = 0; offset.y = 0; offset.z = -50; }
            else if (formation === "line-abreast-rh") { offset.x = 0; offset.y = 0; offset.z = 50; }
            else if (formation === "front") { offset.x = 100; offset.y = 0; offset.z = 0; }
            else offset = undefined;
        }

        var count = 1;
        var xr = 0; var yr = 1; var zr = -1;
        var layer = 1;
        units.forEach((unit: Unit) => {
            if (unit.ID !== ID) {
                if (offset != undefined)
                    /* Offset is set, apply it */
                    unit.followUnit(ID, { "x": offset.x * count, "y": offset.y * count, "z": offset.z * count });
                else {
                    /* More complex formations with variable offsets */
                    if (formation === "diamond") {
                        var xl = xr * Math.cos(Math.PI / 4) - yr * Math.sin(Math.PI / 4);
                        var yl = xr * Math.sin(Math.PI / 4) + yr * Math.cos(Math.PI / 4);
                        unit.followUnit(ID, { "x": -yl * 50, "y": zr * 10, "z": xl * 50 });

                        if (yr == 0) { layer++; xr = 0; yr = layer; zr = -layer; }
                        else {
                            if (xr < layer) { xr++; zr--; }
                            else { yr--; zr++; }
                        }
                    }
                }
                count++;
            }
        })
        this.#showActionMessage(units, `following unit ${this.getUnitByID(ID)?.getUnitName()}`);
    }

    /** Instruct the selected units to perform precision bombing of specific coordinates
     * 
     * @param latlng Location to bomb
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    bombPoint(latlng: LatLng, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.bombPoint(latlng));
        this.#showActionMessage(units, `unit bombing point`);
    }

    /** Instruct the selected units to perform carpet bombing of specific coordinates
     * 
     * @param latlng Location to bomb
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    carpetBomb(latlng: LatLng, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.carpetBomb(latlng));
        this.#showActionMessage(units, `unit carpet bombing point`);
    }

    /** Instruct the selected units to fire at specific coordinates
     * 
     * @param latlng Location to fire at
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    fireAtArea(latlng: LatLng, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.fireAtArea(latlng));
        this.#showActionMessage(units, `unit firing at area`);
    }

    /** Instruct the selected units to simulate a fire fight at specific coordinates
     * 
     * @param latlng Location to fire at
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    simulateFireFight(latlng: LatLng, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        getGroundElevation(latlng, (response: string) => {
            var groundElevation: number | null = null;
            try {
                groundElevation = parseFloat(response);
            } catch {
                console.warn("Simulate fire fight: could not retrieve ground elevation")
            }
            units?.forEach((unit: Unit) => unit.simulateFireFight(latlng, groundElevation));
        });
        this.#showActionMessage(units, `unit simulating fire fight`);
    }

    /** Instruct units to enter into scenic AAA mode. Units will shoot in the air without aiming
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    scenicAAA(units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.scenicAAA());
        this.#showActionMessage(units, `unit set to perform scenic AAA`);
    }

    /** Instruct units to enter into dynamic accuracy/miss on purpose mode. Units will aim to the nearest enemy unit but not precisely.
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    missOnPurpose(units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.missOnPurpose());
        this.#showActionMessage(units, `unit set to perform miss-on-purpose AAA`);
    }

    /** Instruct units to land at specific point
     * 
     * @param latlng Point where to land
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    landAtPoint(latlng: LatLng, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.landAtPoint(latlng));
        this.#showActionMessage(units, `unit landing at point`);
    }

    /** Set a specific shots scatter to all the selected units
     * 
     * @param shotsScatter Value to set
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    setShotsScatter(shotsScatter: number, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, onlyOnePerGroup: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.setShotsScatter(shotsScatter));
        this.#showActionMessage(units, `shots scatter set to ${shotsScatter}`);
    }

    /** Set a specific shots intensity to all the selected units
     * 
     * @param shotsScatter Value to set
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    setShotsIntensity(shotsIntensity: number, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, onlyOnePerGroup: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        units.forEach((unit: Unit) => unit.setShotsIntensity(shotsIntensity));
        this.#showActionMessage(units, `shots intensity set to ${shotsIntensity}`);
    }

    /*********************** Control operations on selected units ************************/
    /**  See getUnitsCategories for more info
     * 
     * @returns Category array of the selected units.
     */
    getSelectedUnitsCategories() {
        return this.getUnitsCategories(this.getSelectedUnits());
    };

    /**  See getUnitsVariable for more info
     * 
     * @param variableGetter CallableFunction that returns the requested variable. Example: getUnitsVariable((unit: Unit) => unit.getName(), foo) will return a string value if all the units have the same name, otherwise it will return undefined.
     * @returns The value of the variable if all units have the same value, else undefined
     */
    getSelectedUnitsVariable(variableGetter: CallableFunction) {
        return this.getUnitsVariable(variableGetter, this.getSelectedUnits());
    };

    /** Groups the selected units in a single (DCS) group, if all the units have the same category 
     * 
     */
    createGroup(units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: false, showProtectionReminder: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        if (this.getUnitsCategories(units).length == 1) {
            var unitsData: { ID: number, location: LatLng }[] = [];
            units.forEach((unit: Unit) => unitsData.push({ ID: unit.ID, location: unit.getPosition() }));
            getApp().getServerManager().cloneUnits(unitsData, true, 0 /* No spawn points, we delete the original units */);
            this.#showActionMessage(units, `created a group`);
        } else {
            (getApp().getPopupsManager().get("infoPopup") as Popup).setText(`Groups can only be created from units of the same category`);
        }
    }

    /** Set the hotgroup for the selected units. It will be the only hotgroup of the unit
     * 
     * @param hotgroup Hotgroup number
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    setHotgroup(hotgroup: number, units: Unit[] | null = null) {
        this.getUnitsByHotgroup(hotgroup).forEach((unit: Unit) => unit.setHotgroup(null));
        this.addToHotgroup(hotgroup);
    }

    /** Add the selected units to a hotgroup. Units can be in multiple hotgroups at the same type
     * 
     * @param hotgroup Hotgroup number
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     */
    addToHotgroup(hotgroup: number, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits();
        units.forEach((unit: Unit) => unit.setHotgroup(hotgroup));
        this.#showActionMessage(units, `added to hotgroup ${hotgroup}`);
        (getApp().getPanelsManager().get("hotgroup") as HotgroupPanel).refreshHotgroups();
    }

    /** Delete the selected units
     * 
     * @param explosion If true, the unit will be deleted using an explosion
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     * @returns 
     */
    delete(explosion: boolean = false, explosionType: string = "", units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeProtected: true, showProtectionReminder: true }); /* Can be applied to humans too */

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return;
        }

        units = segregatedUnits.controllable;

        const selectionContainsAHuman = units.some((unit: Unit) => {
            return unit.getHuman() === true;
        });

        if (selectionContainsAHuman && !confirm("Your selection includes a human player. Deleting humans causes their vehicle to crash.\n\nAre you sure you want to do this?")) {
            return;
        }

        const doDelete = (explosion = false, explosionType = "", immediate = false) => {
            units?.forEach((unit: Unit) => unit.delete(explosion, explosionType, immediate));
            this.#showActionMessage(units as Unit[], `deleted`);
        }

        if (units.length >= DELETE_SLOW_THRESHOLD)
            this.#showSlowDeleteDialog(units).then((action: any) => {
                if (action === "delete-slow")
                    doDelete(explosion, explosionType, false);
                else if (action === "delete-immediate")
                    doDelete(explosion, explosionType, true);
            })
        else
            doDelete(explosion, explosionType);

    }

    /** Compute the destinations of every unit in the selected units. This function preserves the relative positions of the units, and rotates the whole formation by rotation.
     * 
     * @param latlng Center of the group after the translation
     * @param rotation Rotation of the group, in radians
     * @param units (Optional) Array of units to apply the control to. If not provided, the operation will be completed on all selected units.
     * @returns Array of positions for each unit, in order
     */
    computeGroupDestination(latlng: LatLng, rotation: number, units: Unit[] | null = null) {
        if (units === null)
            units = this.getSelectedUnits({ excludeHumans: true, excludeProtected: true, onlyOnePerGroup: true });

        const segregatedUnits = this.segregateUnits(units);
        if (segregatedUnits.controllable.length === 0) {
            this.showProtectedUnitsPopup(segregatedUnits.dcsProtected.length);
            return {};
        }

        units = segregatedUnits.controllable;

        if (units.length === 0)
            return {};

        /* Compute the center of the group */
        var len = units.length;
        var center = { x: 0, y: 0 };
        units.forEach((unit: Unit) => {
            var mercator = latLngToMercator(unit.getPosition().lat, unit.getPosition().lng);
            center.x += mercator.x / len;
            center.y += mercator.y / len;
        });

        /* Compute the distances from the center of the group */
        var unitDestinations: { [key: number]: LatLng } = {};
        units.forEach((unit: Unit) => {
            var mercator = latLngToMercator(unit.getPosition().lat, unit.getPosition().lng);
            var distancesFromCenter = { dx: mercator.x - center.x, dy: mercator.y - center.y };

            /* Rotate the distance according to the group rotation */
            var rotatedDistancesFromCenter: { dx: number, dy: number } = { dx: 0, dy: 0 };
            rotatedDistancesFromCenter.dx = distancesFromCenter.dx * Math.cos(deg2rad(rotation)) - distancesFromCenter.dy * Math.sin(deg2rad(rotation));
            rotatedDistancesFromCenter.dy = distancesFromCenter.dx * Math.sin(deg2rad(rotation)) + distancesFromCenter.dy * Math.cos(deg2rad(rotation));

            /* Compute the final position of the unit */
            var destMercator = latLngToMercator(latlng.lat, latlng.lng);    // Convert destination point to mercator
            var unitMercator = { x: destMercator.x + rotatedDistancesFromCenter.dx, y: destMercator.y + rotatedDistancesFromCenter.dy };  // Compute final position of this unit in mercator coordinates
            var unitLatLng = mercatorToLatLng(unitMercator.x, unitMercator.y);
            unitDestinations[unit.ID] = new LatLng(unitLatLng.lat, unitLatLng.lng);
        });

        return unitDestinations;
    }

    /** Copy the selected units and store their properties in memory
     * 
     */
    copy(units: Unit[] | null = null) {
        if (!getApp().getContextManager().getCurrentContext().getAllowUnitCopying())
            return;

        if (units === null)
            units = this.getSelectedUnits();

        if (units.length === 0)
            return;

        /* A JSON is used to deepcopy the units, creating a "snapshot" of their properties at the time of the copy */
        this.#copiedUnits = JSON.parse(JSON.stringify(units.map((unit: Unit) => { return unit.getData() }))); /* Can be applied to humans too */
        (getApp().getPopupsManager().get("infoPopup") as Popup).setText(`${this.#copiedUnits.length} units copied`);
    }

    /*********************** Unit manipulation functions  ************************/
    /** Paste the copied units
     * 
     * @returns True if units were pasted successfully
     */
    paste() {
        if (!getApp().getContextManager().getCurrentContext().getAllowUnitPasting())
            return;

        let spawnPoints = 0;

        /* If spawns are restricted, check that the user has the necessary spawn points */
        if (getApp().getMissionManager().getCommandModeOptions().commandMode != GAME_MASTER) {
            if (getApp().getMissionManager().getCommandModeOptions().restrictSpawns && getApp().getMissionManager().getRemainingSetupTime() < 0) {
                (getApp().getPopupsManager().get("infoPopup") as Popup).setText(`Units can be pasted only during SETUP phase`);
                return false;
            }

            this.#copiedUnits.forEach((unit: UnitData) => {
                let unitSpawnPoints = getUnitDatabaseByCategory(unit.category)?.getSpawnPointsByName(unit.name);
                if (unitSpawnPoints !== undefined)
                    spawnPoints += unitSpawnPoints;
            })

            if (spawnPoints > getApp().getMissionManager().getAvailableSpawnPoints()) {
                (getApp().getPopupsManager().get("infoPopup") as Popup).setText("Not enough spawn points available!");
                return false;
            }
        }

        if (this.#copiedUnits.length > 0) {
            /* Compute the position of the center of the copied units */
            var nUnits = this.#copiedUnits.length;
            var avgLat = 0;
            var avgLng = 0;
            for (let idx in this.#copiedUnits) {
                var unit = this.#copiedUnits[idx];
                avgLat += unit.position.lat / nUnits;
                avgLng += unit.position.lng / nUnits;
            }

            /* Organize the copied units in groups */
            var groups: { [key: string]: UnitData[] } = {};
            this.#copiedUnits.forEach((unit: UnitData) => {
                if (!(unit.groupName in groups))
                    groups[unit.groupName] = [];
                groups[unit.groupName].push(unit);
            });

            /* Clone the units in groups */
            for (let groupName in groups) {
                var units: { ID: number, location: LatLng }[] = [];
                let markers: TemporaryUnitMarker[] = [];
                groups[groupName].forEach((unit: UnitData) => {
                    var position = new LatLng(getApp().getMap().getMouseCoordinates().lat + unit.position.lat - avgLat, getApp().getMap().getMouseCoordinates().lng + unit.position.lng - avgLng);
                    markers.push(getApp().getMap().addTemporaryMarker(position, unit.name, unit.coalition));
                    units.push({ ID: unit.ID, location: position });
                });

                getApp().getServerManager().cloneUnits(units, false, spawnPoints, (res: any) => {
                    if (res.commandHash !== undefined) {
                        markers.forEach((marker: TemporaryUnitMarker) => {
                            marker.setCommandHash(res.commandHash);
                        })
                    }
                });
            }
            (getApp().getPopupsManager().get("infoPopup") as Popup).setText(`${this.#copiedUnits.length} units pasted`);
        }
        else {
            (getApp().getPopupsManager().get("infoPopup") as Popup).setText("No units copied!");
        }
    }

    /** Automatically create an Integrated Air Defence System from a CoalitionArea object. The units will be mostly focused around big cities. The bigger the city, the larger the amount of units created next to it.
     * If the CoalitionArea does not contain any city, no units will be created
     * 
     * @param coalitionArea Boundaries of the IADS
     * @param types Array of unit types to add to the IADS, e.g. AAA, SAM, flak, MANPADS
     * @param eras Array of eras to which the units added to the IADS can belong
     * @param ranges Array of weapon ranges the units can have 
     * @param density Value between 0 and 100, controls the amout of units created
     * @param distribution Value between 0 and 100, controls how "scattered" the units will be
     */
    createIADS(coalitionArea: CoalitionArea, types: { [key: string]: boolean }, eras: { [key: string]: boolean }, ranges: { [key: string]: boolean }, density: number, distribution: number, forceCoalition: boolean) {
        const activeTypes = Object.keys(types).filter((key: string) => { return types[key]; });
        const activeEras = Object.keys(eras).filter((key: string) => { return eras[key]; });
        const activeRanges = Object.keys(ranges).filter((key: string) => { return ranges[key]; });

        var airbases = getApp().getMissionManager().getAirbases();
        Object.keys(airbases).forEach((airbaseName: string) => {
            var airbase = airbases[airbaseName];
            /* Check if the city is inside the coalition area */
            if (polyContains(new LatLng(airbase.getLatLng().lat, airbase.getLatLng().lng), coalitionArea)) {
                /* Arbitrary formula to obtain a number of units */
                var pointsNumber = 2 + 10 * density / 100;
                for (let i = 0; i < pointsNumber; i++) {
                    /* Place the unit nearby the airbase, depending on the distribution parameter */
                    var bearing = Math.random() * 360;
                    var distance = Math.random() * distribution * 100;
                    const latlng = bearingAndDistanceToLatLng(airbase.getLatLng().lat, airbase.getLatLng().lng, bearing, distance);

                    /* Make sure the unit is still inside the coalition area */
                    if (polyContains(latlng, coalitionArea)) {
                        const type = activeTypes[Math.floor(Math.random() * activeTypes.length)];
                        if (Math.random() < IADSDensities[type]) {
                            /* Get a random blueprint depending on the selected parameters and spawn the unit */
                            let unitBlueprint: UnitBlueprint | null;
                            if (forceCoalition)
                                unitBlueprint = randomUnitBlueprint(groundUnitDatabase, { type: type, eras: activeEras, ranges: activeRanges, coalition: coalitionArea.getCoalition()});
                            else 
                                unitBlueprint = randomUnitBlueprint(groundUnitDatabase, { type: type, eras: activeEras, ranges: activeRanges });

                            if (unitBlueprint)
                                this.spawnUnits("GroundUnit", [{ unitType: unitBlueprint.name, location: latlng, liveryID: "" }], coalitionArea.getCoalition(), false, "", "");
                        }
                    }
                }
            }
        })

        citiesDatabase.forEach((city: { lat: number, lng: number, pop: number }) => {
            /* Check if the city is inside the coalition area */
            if (polyContains(new LatLng(city.lat, city.lng), coalitionArea)) {
                /* Arbitrary formula to obtain a number of units depending on the city population */
                var pointsNumber = 2 + Math.pow(city.pop, 0.15) * density / 100;
                for (let i = 0; i < pointsNumber; i++) {
                    /* Place the unit nearby the city, depending on the distribution parameter */
                    var bearing = Math.random() * 360;
                    var distance = Math.random() * distribution * 100;
                    const latlng = bearingAndDistanceToLatLng(city.lat, city.lng, bearing, distance);

                    /* Make sure the unit is still inside the coalition area */
                    if (polyContains(latlng, coalitionArea)) {
                        const type = activeTypes[Math.floor(Math.random() * activeTypes.length)];
                        if (Math.random() < IADSDensities[type]) {
                            /* Get a random blueprint depending on the selected parameters and spawn the unit */
                            let unitBlueprint: UnitBlueprint | null;
                            if (forceCoalition)
                                unitBlueprint = randomUnitBlueprint(groundUnitDatabase, { type: type, eras: activeEras, ranges: activeRanges, coalition: coalitionArea.getCoalition()});
                            else 
                                unitBlueprint = randomUnitBlueprint(groundUnitDatabase, { type: type, eras: activeEras, ranges: activeRanges });

                            if (unitBlueprint)
                                this.spawnUnits("GroundUnit", [{ unitType: unitBlueprint.name, location: latlng, liveryID: "" }], coalitionArea.getCoalition(), false, "", "");
                        }
                    }
                }
            }
        })
    }

    /** Export all the ground and navy units to file. Does not work on Aircraft and Helicopter units.
     *  TODO: Extend to aircraft and helicopters
     */
    exportToFile() {
        if (!this.#unitDataExport)
            this.#unitDataExport = new UnitDataFileExport("unit-export-dialog");
        this.#unitDataExport.showForm(Object.values(this.#units));
    }

    /** Import ground and navy units from file
     * TODO: extend to support aircraft and helicopters
     */
    importFromFile() {
        if (!this.#unitDataImport)
            this.#unitDataImport = new UnitDataFileImport("unit-import-dialog");
        this.#unitDataImport.selectFile();
    }

    /** Spawn a new group of units
     * 
     * @param category Category of the new units
     * @param units Array of unit tables 
     * @param coalition Coalition to which the new units will belong
     * @param immediate If true the command will be performed immediately, but this may cause lag on the server
     * @param airbase If true, the location of the units will be ignored and the units will spawn at the given airbase. Only works for aircrafts and helicopters
     * @param country Set the country of the units. If empty string, the country will be assigned automatically
     * @param callback CallableFunction called when the command is received by the server
     * @returns True if the spawn command was successfully sent
     */
    spawnUnits(category: string, units: UnitSpawnTable[], coalition: string = "blue", immediate: boolean = true, airbase: string = "", country: string = "", callback: CallableFunction = () => { }) {
        var spawnPoints = 0;
        var spawnFunction = () => { };
        var spawnsRestricted = getApp().getMissionManager().getCommandModeOptions().restrictSpawns && getApp().getMissionManager().getRemainingSetupTime() < 0 && getApp().getMissionManager().getCommandModeOptions().commandMode !== GAME_MASTER;

        if (category === "Aircraft") {
            if (airbase == "" && spawnsRestricted) {
                (getApp().getPopupsManager().get("infoPopup") as Popup).setText("Aircrafts can be air spawned during the SETUP phase only");
                return false;
            }
            spawnPoints = units.reduce((points: number, unit: UnitSpawnTable) => { return points + aircraftDatabase.getSpawnPointsByName(unit.unitType) }, 0);
            spawnFunction = () => getApp().getServerManager().spawnAircrafts(units, coalition, airbase, country, immediate, spawnPoints, callback);
        } else if (category === "Helicopter") {
            if (airbase == "" && spawnsRestricted) {
                (getApp().getPopupsManager().get("infoPopup") as Popup).setText("Helicopters can be air spawned during the SETUP phase only");
                return false;
            }
            spawnPoints = units.reduce((points: number, unit: UnitSpawnTable) => { return points + helicopterDatabase.getSpawnPointsByName(unit.unitType) }, 0);
            spawnFunction = () => getApp().getServerManager().spawnHelicopters(units, coalition, airbase, country, immediate, spawnPoints, callback);

        } else if (category === "GroundUnit") {
            if (spawnsRestricted) {
                (getApp().getPopupsManager().get("infoPopup") as Popup).setText("Ground units can be spawned during the SETUP phase only");
                return false;
            }
            spawnPoints = units.reduce((points: number, unit: UnitSpawnTable) => { return points + groundUnitDatabase.getSpawnPointsByName(unit.unitType) }, 0);
            spawnFunction = () => getApp().getServerManager().spawnGroundUnits(units, coalition, country, immediate, spawnPoints, callback);

        } else if (category === "NavyUnit") {
            if (spawnsRestricted) {
                (getApp().getPopupsManager().get("infoPopup") as Popup).setText("Navy units can be spawned during the SETUP phase only");
                return false;
            }
            spawnPoints = units.reduce((points: number, unit: UnitSpawnTable) => { return points + navyUnitDatabase.getSpawnPointsByName(unit.unitType) }, 0);
            spawnFunction = () => getApp().getServerManager().spawnNavyUnits(units, coalition, country, immediate, spawnPoints, callback);
        }

        if (spawnPoints <= getApp().getMissionManager().getAvailableSpawnPoints()) {
            getApp().getMissionManager().setSpentSpawnPoints(spawnPoints);
            spawnFunction();
            document.dispatchEvent( new CustomEvent( "unitSpawned", {
                "detail": {
                    "airbase": airbase,
                    "category": category,
                    "coalition": coalition,
                    "country": country,
                    "immediate": immediate,
                    "unitSpawnTable": units
                }
            }));
            return true;
        } else {
            (getApp().getPopupsManager().get("infoPopup") as Popup).setText("Not enough spawn points available!");
            return false;
        }
    }

    /***********************************************/
    #onKeyUp(event: KeyboardEvent) {
        if (!keyEventWasInInput(event)) {
            if (event.key === "Delete")
                this.delete();
            else if (event.key === "a" && event.ctrlKey)
                Object.values(this.getUnits()).filter((unit: Unit) => { return !unit.getHidden() }).forEach((unit: Unit) => unit.setSelected(true));
        }
    }

    #onUnitSelection(unit: Unit) {
        if (this.getSelectedUnits().length > 0) {
            /* Disable the firing of the selection event for a certain amount of time. This avoids firing many events if many units are selected */
            if (!this.#selectionEventDisabled) {
                getApp().getMap().setState(MOVE_UNIT);
                window.setTimeout(() => {
                    document.dispatchEvent(new CustomEvent("unitsSelection", { detail: this.getSelectedUnits() }));
                    this.#selectionEventDisabled = false;
                    this.#showNumberOfSelectedProtectedUnits();
                }, 100);
                this.#selectionEventDisabled = true;
            }
        }
        else {
            getApp().getMap().setState(IDLE);
            document.dispatchEvent(new CustomEvent("clearSelection"));
        }
    }

    #onUnitDeselection(unit: Unit) {
        if (this.getSelectedUnits().length == 0) {
            getApp().getMap().setState(IDLE);
            document.dispatchEvent(new CustomEvent("clearSelection"));
        }
        else {
            /* Disable the firing of the selection event for a certain amount of time. This avoids firing many events if many units are selected */
            if (!this.#deselectionEventDisabled) {
                window.setTimeout(() => {
                    document.dispatchEvent(new CustomEvent("unitsDeselection", { detail: this.getSelectedUnits() }));
                    this.#deselectionEventDisabled = false;
                }, 100);
                this.#deselectionEventDisabled = true;
            }
        }
    }

    #showActionMessage(units: Unit[], message: string) {
        if (units.length == 1)
            (getApp().getPopupsManager().get("infoPopup") as Popup).setText(`${units[0].getUnitName()} ${message}`);
        else if (units.length > 1)
            (getApp().getPopupsManager().get("infoPopup") as Popup).setText(`${units[0].getUnitName()} and ${units.length - 1} other units ${message}`);
    }

    #showSlowDeleteDialog(units: Unit[]) {
        let button: HTMLButtonElement | null = null;
        const deletionTime = Math.round(units.length * DELETE_CYCLE_TIME).toString();
        const dialog = this.#slowDeleteDialog;
        const element = dialog.getElement();
        const listener = (ev: MouseEvent) => {
            if (ev.target instanceof HTMLButtonElement && ev.target.matches("[data-action]"))
                button = ev.target;
        }

        element.querySelectorAll(".deletion-count").forEach(el => el.innerHTML = units.length.toString());
        element.querySelectorAll(".deletion-time").forEach(el => el.innerHTML = deletionTime);
        dialog.show();

        return new Promise((resolve) => {
            element.addEventListener("click", listener);

            const interval = setInterval(() => {
                if (button instanceof HTMLButtonElement) {
                    clearInterval(interval);
                    dialog.hide();
                    element.removeEventListener("click", listener);
                    resolve(button.getAttribute("data-action"));
                }
            }, 250);
        });
    }

    #showNumberOfSelectedProtectedUnits() {
        const map = getApp().getMap();
        const units = this.getSelectedUnits();
        const numSelectedUnits = units.length;
        const numProtectedUnits = units.filter((unit: Unit) => map.getIsUnitProtected(unit)).length;

        if (numProtectedUnits === 1 && numSelectedUnits === numProtectedUnits)
            (getApp().getPopupsManager().get("infoPopup") as Popup).setText(`Notice: unit is protected`);

        if (numProtectedUnits > 1)
            (getApp().getPopupsManager().get("infoPopup") as Popup).setText(`Notice: selection contains ${numProtectedUnits} protected units.`);
    }

    #unitIsProtected(unit: Unit) {
        return getApp().getMap().getIsUnitProtected(unit)
    }
}